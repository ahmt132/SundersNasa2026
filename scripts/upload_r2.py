r"""Upload the website data (web/public/data) to a Cloudflare R2 bucket.

Run from the project folder:
    .venv\Scripts\python scripts\upload_r2.py --cors https://example.org
Credentials come only from environment variables (create an R2 API token with
"Object Read & Write" for the bucket in the Cloudflare dashboard):
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
Files already in the bucket with the same size and MD5 are skipped, so a re-run only sends what
changed. --delete also removes bucket files that no longer exist locally.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "public" / "data"
TYPES = {".json": "application/json", ".bin": "application/octet-stream"}
# Single-part uploads up to 200 MB (the largest data file is ~72 MB), so each object's ETag is
# its MD5 and unchanged files can be recognised without downloading them.
TRANSFER = TransferConfig(multipart_threshold=200 * 1024 * 1024, use_threads=False)


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"Environment variable {name} is not set (see docs/DEPLOY_CLOUDFLARE.md).")
    return v


def md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--folder", type=Path, default=DATA, help="local data folder (default web/public/data)")
    ap.add_argument("--prefix", default="", help="key prefix inside the bucket (default: bucket root)")
    ap.add_argument("--cors", nargs="*", default=None, metavar="ORIGIN",
                    help="set the bucket CORS rule to allow these site origins (localhost:5173 is always added)")
    ap.add_argument("--delete", action="store_true", help="remove bucket files that are not in the local folder")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--max-age", type=int, default=3600, help="Cache-Control max-age in seconds")
    a = ap.parse_args()

    folder = a.folder.resolve()
    if not (folder / "index.json").is_file():
        sys.exit(f"{folder} has no index.json; run `python -m pipeline.run export-static` first.")
    bucket = env("R2_BUCKET")
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
        aws_access_key_id=env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(max_pool_connections=a.workers + 4, retries={"max_attempts": 8, "mode": "adaptive"}),
    )
    prefix = a.prefix.strip("/") + "/" if a.prefix.strip("/") else ""

    if a.cors is not None:
        origins = sorted({o.rstrip("/") for o in a.cors} | {"http://localhost:5173"})
        try:
            s3.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": [{
                "AllowedOrigins": origins, "AllowedMethods": ["GET", "HEAD"],
                "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400}]})
            print("CORS allows:", ", ".join(origins))
        except ClientError as e:
            # An "Object Read & Write" token may not change bucket settings; the upload still works.
            print(f"Could not set CORS ({e.response['Error'].get('Code')}). Set it in the dashboard instead: "
                  "bucket -> Settings -> CORS Policy (docs/DEPLOY_CLOUDFLARE.md). Continuing with the upload.")

    remote: dict[str, tuple[int, str]] = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            remote[o["Key"]] = (o["Size"], o["ETag"].strip('"'))

    files = sorted(p for p in folder.rglob("*") if p.is_file())
    local = {prefix + p.relative_to(folder).as_posix(): p for p in files}
    todo = []
    for key, p in local.items():
        r = remote.get(key)
        if r is None or r[0] != p.stat().st_size or r[1] != md5(p):
            todo.append((key, p))
    # index.json last, so visitors never see an index that points to files not uploaded yet.
    todo.sort(key=lambda kp: kp[0].endswith("index.json"))
    total = sum(p.stat().st_size for _, p in todo)
    print(f"{len(local)} local files, {len(local) - len(todo)} unchanged, "
          f"{len(todo)} to upload ({total / 1e9:.2f} GB)")

    def put(key: str, p: Path) -> int:
        s3.upload_file(str(p), bucket, key, Config=TRANSFER, ExtraArgs={
            "ContentType": TYPES.get(p.suffix, "application/octet-stream"),
            "CacheControl": f"public, max-age={a.max_age}"})
        return p.stat().st_size

    index = [kp for kp in todo if kp[0] == prefix + "index.json"]
    rest = [kp for kp in todo if kp not in index]
    done = 0
    with ThreadPoolExecutor(a.workers) as pool:
        futs = [pool.submit(put, k, p) for k, p in rest]
        for i, f in enumerate(as_completed(futs), 1):
            done += f.result()
            if i % 100 == 0 or i == len(futs):
                print(f"  {i}/{len(futs)} files, {done / 1e9:.2f} GB")
    for k, p in index:
        put(k, p)

    if a.delete:
        stale = [k for k in remote if k not in local]
        for i in range(0, len(stale), 1000):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]]})
        print(f"Removed {len(stale)} files that are no longer in the local data folder.")
    print("Done. If the site still shows old numbers, purge the Cloudflare cache for the data domain.")


if __name__ == "__main__":
    main()
