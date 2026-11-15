// Quick areas for the area menu. Each is a plain rectangle (west, south, east, north in degrees);
// edges on whole or tenth degrees, so the monthly values are exact sums of the grid cells inside.
// The ids are used in share links (?sel=region:<id>), so keep existing ids unchanged.

export interface QuickArea {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  group: "World" | "Continents" | "Fire regions";
}

export const QUICK_AREAS: QuickArea[] = [
  { id: "world", name: "Whole world", bbox: [-180, -90, 180, 90], group: "World" },

  { id: "africa", name: "Africa", bbox: [-18, -35, 52, 38], group: "Continents" },
  { id: "asia", name: "Asia", bbox: [26, -11, 180, 78], group: "Continents" },
  { id: "europe", name: "Europe", bbox: [-25, 34, 45, 72], group: "Continents" },
  { id: "north_america", name: "North America", bbox: [-170, 7, -52, 84], group: "Continents" },
  { id: "south_america", name: "South America", bbox: [-82, -56, -34, 13], group: "Continents" },
  { id: "oceania", name: "Australia and Oceania", bbox: [110, -48, 180, 0], group: "Continents" },

  { id: "amazon_para_rondonia", name: "Brazilian Amazon (Pará / Rondônia)", bbox: [-67, -14, -46, 3], group: "Fire regions" },
  { id: "pantanal", name: "Pantanal (Brazil / Bolivia)", bbox: [-59, -22, -54, -15.5], group: "Fire regions" },
  { id: "bolivia", name: "Bolivia", bbox: [-69.7, -22.9, -57.4, -9.7], group: "Fire regions" },
  { id: "central_chile", name: "Central Chile", bbox: [-74, -40, -70, -32], group: "Fire regions" },
  { id: "california", name: "California", bbox: [-124.5, 32.5, -114.1, 42.1], group: "Fire regions" },
  { id: "western_canada", name: "Western Canada (British Columbia / Alberta)", bbox: [-130, 49, -110, 60], group: "Fire regions" },
  { id: "quebec", name: "Quebec, Canada (2023 fires)", bbox: [-80, 47, -65, 56], group: "Fire regions" },
  { id: "central_africa", name: "Central Africa (Congo / Angola / Zambia)", bbox: [11, -18, 32, 5], group: "Fire regions" },
  { id: "sahel", name: "West African Sahel and savanna", bbox: [-17, 6, 15, 16], group: "Fire regions" },
  { id: "iberia", name: "Spain and Portugal", bbox: [-9.6, 36, 3.4, 43.8], group: "Fire regions" },
  { id: "greece", name: "Greece", bbox: [19.5, 34.8, 28.3, 41.8], group: "Fire regions" },
  { id: "turkiye_med", name: "Türkiye Mediterranean coast (Antalya–Muğla)", bbox: [27, 35.8, 33, 37.9], group: "Fire regions" },
  { id: "kazakhstan", name: "Kazakhstan steppe", bbox: [46, 40, 87, 56], group: "Fire regions" },
  { id: "siberia", name: "Eastern Siberia (Yakutia)", bbox: [105, 56, 150, 72], group: "Fire regions" },
  { id: "punjab", name: "Punjab and Haryana, India (crop burning)", bbox: [73.8, 28.5, 77.6, 32.5], group: "Fire regions" },
  { id: "mainland_se_asia", name: "Mainland Southeast Asia (Myanmar / Thailand / Laos)", bbox: [92, 10, 110, 28], group: "Fire regions" },
  { id: "indonesia", name: "Indonesia (Sumatra and Borneo)", bbox: [95, -6, 119, 7.5], group: "Fire regions" },
  { id: "northern_australia", name: "Northern Australia", bbox: [120, -20, 146, -10.5], group: "Fire regions" },
];
