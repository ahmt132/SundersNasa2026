"""Selection geometry: parsing, validation, and grid-cell classification."""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

EARTH_RADIUS_KM = 6371.0088
MAX_RADIUS_KM = 500.0
MAX_VERTICES = 5000


class ApiError(Exception):
    """An error the client can act on. Rendered as {"error": {"code", "message"}}."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def circle(lat: float, lon: float, radius_km: float, vertices: int = 72) -> BaseGeometry:
    """Great-circle polygon around a point (not a planar buffer, so it is right at any latitude)."""
    d = radius_km / EARTH_RADIUS_KM
    phi, lam = math.radians(lat), math.radians(lon)
    ring = []
    for k in range(vertices):
        theta = 2 * math.pi * k / vertices
        phi2 = math.asin(math.sin(phi) * math.cos(d) + math.cos(phi) * math.sin(d) * math.cos(theta))
        lam2 = lam + math.atan2(math.sin(theta) * math.sin(d) * math.cos(phi),
                                math.cos(d) - math.sin(phi) * math.sin(phi2))
        ring.append((math.degrees(lam2), math.degrees(phi2)))
    return shapely.Polygon(ring)


def _from_geojson(text: str) -> BaseGeometry:
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ApiError(422, "invalid_geometry", f"geom is not valid JSON: {exc.msg}") from None
    try:
        if obj.get("type") == "FeatureCollection":
            geom = shapely.unary_union([shape(f["geometry"]) for f in obj["features"]])
        elif obj.get("type") == "Feature":
            geom = shape(obj["geometry"])
        else:
            geom = shape(obj)
    except Exception:
        raise ApiError(422, "invalid_geometry", "geom must be a GeoJSON Polygon, MultiPolygon, Feature or FeatureCollection") from None
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise ApiError(422, "invalid_geometry", f"geom must be a Polygon or MultiPolygon, got {geom.geom_type}")
    return geom


def parse_selection(*, geom: str | None, bbox: str | None, lat: float | None, lon: float | None,
                    radius_km: float | None, region: str | None, regions: dict) -> tuple[BaseGeometry, dict]:
    """Exactly one of: geom, bbox, (lat, lon, radius_km), region."""
    point = lat is not None or lon is not None or radius_km is not None
    given = [name for name, on in (("geom", geom), ("bbox", bbox), ("lat/lon/radius_km", point), ("region", region)) if on]
    if len(given) != 1:
        raise ApiError(422, "invalid_selection",
                       "give exactly one of: geom (GeoJSON), bbox (west,south,east,north), "
                       "lat+lon+radius_km, or region (id from /regions)"
                       + (f"; got {', '.join(given)}" if given else ""))
    if region:
        if region not in regions:
            raise ApiError(404, "unknown_region", f"unknown region '{region}'. Available: {', '.join(sorted(regions))}")
        return shapely.box(*regions[region]["bbox"]), {"type": "region", "region": region}
    if bbox:
        try:
            w, s, e, n = (float(v) for v in bbox.split(","))
        except ValueError:
            raise ApiError(422, "invalid_selection", "bbox must be four numbers: west,south,east,north") from None
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ApiError(422, "invalid_selection", "bbox must satisfy west < east and south < north, in degrees")
        return shapely.box(w, s, e, n), {"type": "bbox", "bbox": [w, s, e, n]}
    if point:
        if lat is None or lon is None or radius_km is None:
            raise ApiError(422, "invalid_selection", "lat, lon and radius_km must be given together")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ApiError(422, "invalid_selection", "lat must be in [-90, 90] and lon in [-180, 180]")
        if not (0 < radius_km <= MAX_RADIUS_KM):
            raise ApiError(422, "invalid_selection", f"radius_km must be in (0, {MAX_RADIUS_KM:g}]")
        return circle(lat, lon, radius_km), {"type": "circle", "lat": lat, "lon": lon, "radius_km": radius_km}

    g = _from_geojson(geom)
    if shapely.get_num_coordinates(g) > MAX_VERTICES:
        raise ApiError(413, "selection_too_large", f"geometry has more than {MAX_VERTICES} vertices; simplify it")
    if not g.is_valid:
        g = shapely.make_valid(g)
        g = shapely.unary_union([p for p in getattr(g, "geoms", [g]) if p.geom_type in ("Polygon", "MultiPolygon")])
    w, s, e, n = g.bounds if not g.is_empty else (0, 0, 0, 0)
    if g.is_empty or g.area == 0:
        raise ApiError(422, "invalid_geometry", "geometry has no area")
    if not (-180 <= w and e <= 180 and -90 <= s and n <= 90):
        raise ApiError(422, "invalid_geometry", "coordinates must be longitude, latitude in degrees (WGS84)")
    return g, {"type": "polygon", "bbox": [w, s, e, n]}


def classify_cells(geom: BaseGeometry, cells_per_deg: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split the grid cells under a geometry into (fully inside, crossing the edge).

    Fully-inside cells can be answered from pre-aggregated Parquet; only edge cells need an
    exact point-in-polygon test on individual hotspots.
    """
    C = cells_per_deg
    w, s, e, n = geom.bounds
    ix = np.arange(math.floor((w + 180) * C), math.floor((e + 180) * C) + 1)
    iy = np.arange(math.floor((s + 90) * C), math.floor((n + 90) * C) + 1)
    gx, gy = (a.ravel() for a in np.meshgrid(ix, iy))
    boxes = shapely.box(gx / C - 180, gy / C - 90, (gx + 1) / C - 180, (gy + 1) / C - 90)
    shapely.prepare(geom)
    inside = shapely.covers(geom, boxes)
    edge = shapely.intersects(geom, boxes) & ~inside
    frame = lambda mask: pd.DataFrame({"ix": gx[mask].astype("int32"), "iy": gy[mask].astype("int32")})  # noqa: E731
    return frame(inside), frame(edge)
