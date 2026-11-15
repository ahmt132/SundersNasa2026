// The result tabs under the map, and the plain-language "How it works" text (the method window).

export type ResultTab = "calendar" | "seasonal" | "annual" | "sensors";

export const TAB_LABELS: Record<ResultTab, string> = {
  calendar: "Burning calendar",
  seasonal: "Seasonal profile",
  annual: "Year by year",
  sensors: "MODIS vs VIIRS",
};

/** How the harmonization works, in plain words. */
export function MethodText() {
  return (
    <>
      <h3>The problem</h3>
      <p>Two kinds of NASA satellites count fires from space:</p>
      <ul>
        <li><strong>MODIS</strong> (since 2000) sees the Earth in 1 km pixels, a blurry view.</li>
        <li><strong>VIIRS</strong> (since 2012) sees it in 375 m pixels, a sharp view. It counts the same fire as many more dots: about <strong>4 times more</strong> than MODIS.</li>
      </ul>
      <p>If you simply add up the dots, fires seem to jump up in 2012. They did not: only the camera changed.</p>

      <h3>How we fix it</h3>
      <ol>
        <li><strong>Clean.</strong> We keep only confident detections of burning vegetation and remove volcanoes, gas flares, factories and duplicates.</li>
        <li><strong>Compare.</strong> Since 2012 both satellites have been flying at the same time. For every 1° square of the world and every month, we compare how many dots each one counted.</li>
        <li><strong>Learn the rule.</strong> From thousands of these comparisons we learn: <em>&quot;when VIIRS counts this many, MODIS would have counted that many.&quot;</em> The rule is learned separately for each region and season, because a grass fire in Africa and a forest fire in Siberia look different to the satellites.</li>
        <li><strong>Translate.</strong> Every VIIRS count is converted into MODIS units. Before 2012 we use the real MODIS counts, unchanged.</li>
        <li><strong>Test.</strong> We hide one year, learn the rule from the other years, and check how well it predicts the hidden year. We repeat this for every year and keep, for each region, the method that predicts best.</li>
      </ol>

      <h3>The result</h3>
      <p>One fire record from 2000 to today, measured with the same ruler. Before the translation VIIRS counts about four times more than MODIS; after it, the two agree. You can see this in the <strong>MODIS vs VIIRS</strong> tab: the orange (translated) line sits on the blue (MODIS) line.</p>
      <p>It works like converting inches to centimetres, except that the conversion is learned for every part of the world and every season.</p>

      <h3>Good to know</h3>
      <ul>
        <li>From 2000 to mid-2002 only one MODIS satellite (Terra) was flying. Those months are scaled up to two-satellite level and shown with stripes in the burning calendar.</li>
        <li>Neither satellite can see fires hidden by cloud or smoke, or fires that start and end between their passes.</li>
        <li>Big areas and long periods are very accurate; a small area in a single month can be off by about 15–25 %.</li>
      </ul>
    </>
  );
}
