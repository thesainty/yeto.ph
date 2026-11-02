const adjectives = [
  "bouncy", "sleepy", "happy", "wiggly", "jolly", "silly", "sunny", "cozy",
  "tiny", "zippy", "bubbly", "dancing", "giggle", "cheery", "chill", "wobbly",
];
const foods = [
  "taho", "pandesal", "lumpia", "mango", "pancit", "adobo", "buko", "calamansi",
  "halohalo", "bibingka", "turon", "suman", "kutsinta", "sago", "siopao", "ube",
];

/** A draft suggestion; availability is checked when the profile is saved. */
export function suggestFunUsername(previous = ""): string {
  const values = crypto.getRandomValues(new Uint32Array(3));
  const base = `${adjectives[values[0] % adjectives.length]}_${foods[values[1] % foods.length]}`;
  const suffix = values[2] % 10_000;
  const suggested = `${base}_${String(suffix).padStart(4, "0")}`;
  return suggested === previous
    ? `${base}_${String((suffix + 1) % 10_000).padStart(4, "0")}`
    : suggested;
}
