/**
 * Geo-classification of a reel into one of three Texas markets:
 *   - "san_antonio": San Antonio metro + Schertz, Cibolo, Alamo Ranch, New Braunfels, etc.
 *   - "austin":      Austin metro and NORTH (Round Rock, Georgetown, Pflugerville, etc.)
 *   - "dallas":      Dallas / Fort Worth / DFW-area cities
 *
 * Strategy: a fast deterministic keyword pass first (no API cost, fully
 * predictable for the explicit city names the user named). If the keyword pass
 * is ambiguous, fall back to the AI model reading the caption + on-screen text.
 */
import { invokeLLM } from "./_core/llm";

export type Market = "san_antonio" | "austin" | "dallas";

/** Explicit place-name rules the user dictated, plus common metro suburbs. */
const SAN_ANTONIO_PLACES = [
  "san antonio",
  "schertz",
  "cibolo",
  "alamo ranch",
  "new braunfels",
  "converse",
  "selma",
  "universal city",
  "boerne",
  "helotes",
  "stone oak",
  "live oak",
  "seguin",
  "bulverde",
  "canyon lake",
];

const AUSTIN_PLACES = [
  "austin",
  "round rock",
  "georgetown",
  "pflugerville",
  "cedar park",
  "leander",
  "kyle",
  "buda",
  "hutto",
  "lakeway",
  "bee cave",
  "dripping springs",
  "manor",
  "taylor",
  "san marcos", // between SA and Austin — user assigns to Austin
  "temple",     // north of Austin
  "killeen",
  "belton",
  "waco",
];

const DALLAS_PLACES = [
  "dallas",
  "fort worth",
  "ft worth",
  "ft. worth",
  "dfw",
  "arlington",
  "plano",
  "frisco",
  "mckinney",
  "irving",
  "garland",
  "denton",
  "mansfield",
  "grand prairie",
  "mesquite",
  "rockwall",
  "allen",
  "carrollton",
  "richardson",
  "euless",
  "bedford",
  "keller",
  "grapevine",
  "north richland hills",
  "burleson",
  "waxahachie",
  "midlothian",
  "cleburne",
];

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/**
 * Deterministic keyword classification. Returns a market if exactly one market's
 * place names appear in the text, otherwise null (ambiguous -> let AI decide).
 */
export function classifyByKeywords(caption?: string | null, onscreen?: string | null): Market | null {
  const text = `${norm(onscreen)} ${norm(caption)}`;
  const hit = (places: string[]) => places.some(p => text.includes(p));
  const sa = hit(SAN_ANTONIO_PLACES);
  const austin = hit(AUSTIN_PLACES);
  const dallas = hit(DALLAS_PLACES);
  const count = Number(sa) + Number(austin) + Number(dallas);
  if (count !== 1) return null; // none or conflicting -> ambiguous
  if (sa) return "san_antonio";
  if (austin) return "austin";
  return "dallas";
}

/**
 * AI fallback classification. Reads caption + on-screen text and (optionally) the
 * thumbnail, then returns one of the three markets. Defaults to san_antonio only
 * if the model fails entirely (caller can decide to skip instead).
 */
export async function classifyByAI(
  caption?: string | null,
  onscreen?: string | null,
  thumbnailUrl?: string | null
): Promise<Market> {
  const system = `You classify Texas real-estate Instagram reels into exactly ONE market based on the location shown.
Markets and rules:
- "san_antonio": San Antonio and its metro/suburbs, INCLUDING Schertz, Cibolo, Alamo Ranch, New Braunfels, Converse, Selma, Boerne, Seguin, Canyon Lake.
- "austin": Austin and NORTH — Austin, Round Rock, Georgetown, Pflugerville, Cedar Park, Leander, Kyle, Buda, Hutto, Lakeway, Dripping Springs, San Marcos, Temple, Killeen, Belton, Waco.
- "dallas": Dallas / Fort Worth / DFW metroplex — Dallas, Fort Worth, Arlington, Plano, Frisco, McKinney, Irving, Denton, Mansfield, and other DFW-area cities.
Decide using on-screen location text first, then caption hints. Respond with ONLY the market key.`;

  const userText = `On-screen text: ${onscreen || "(none)"}
Caption: ${caption || "(none)"}
Which market is this? Answer with one of: san_antonio, austin, dallas.`;

  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" } }> = [
    { type: "text", text: userText },
  ];
  if (thumbnailUrl) {
    content.push({ type: "image_url", image_url: { url: thumbnailUrl, detail: "low" } });
  }

  try {
    const res = await invokeLLM({
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "market_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              market: { type: "string", enum: ["san_antonio", "austin", "dallas"] },
            },
            required: ["market"],
            additionalProperties: false,
          },
        },
      },
    });
    const raw = res.choices?.[0]?.message?.content;
    const txt = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(txt) as { market?: Market };
    if (parsed.market === "austin" || parsed.market === "dallas" || parsed.market === "san_antonio") {
      return parsed.market;
    }
  } catch {
    // fall through
  }
  // Last resort: keyword pass (may still be null) else default to san_antonio.
  return classifyByKeywords(caption, onscreen) ?? "san_antonio";
}

/**
 * Full classification: keyword first (cheap + deterministic), AI fallback when
 * ambiguous. This is what ingestion + re-classification should call.
 */
export async function classifyMarket(
  caption?: string | null,
  onscreen?: string | null,
  thumbnailUrl?: string | null
): Promise<Market> {
  const byKw = classifyByKeywords(caption, onscreen);
  if (byKw) return byKw;
  return classifyByAI(caption, onscreen, thumbnailUrl);
}
