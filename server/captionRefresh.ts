import { invokeLLM } from "./_core/llm";

const CAPTION_MODEL = "claude-haiku-4-5";

/**
 * Split off the trailing hashtag block so it is never altered.
 */
export function splitHashtags(caption: string): { body: string; tags: string } {
  const lines = caption.replace(/\s+$/, "").split("\n");
  const tagLines: string[] = [];
  while (lines.length && lines[lines.length - 1].trim().startsWith("#")) {
    tagLines.unshift(lines.pop() as string);
  }
  return { body: lines.join("\n").replace(/\s+$/, ""), tags: tagLines.join("\n").trim() };
}

/**
 * Lightly refresh ONLY the opening line(s) of a caption. The description body,
 * any call-to-action, and all hashtags are preserved exactly.
 *
 * Falls back to the original caption if the LLM is unavailable or returns
 * anything unsafe (added hashtags, empty output).
 */
export async function refreshCaption(caption: string): Promise<string> {
  const { body, tags } = splitHashtags(caption || "");
  if (!body.trim()) return caption;

  try {
    const prompt =
      "You rewrite an Instagram real-estate caption so a reposted reel reads as FRESH, distinct copy " +
      "(not a near-duplicate of the original), while keeping the exact same offer and intent.\n" +
      "STRICT RULES:\n" +
      "- Rewrite the DESCRIPTIVE hook/body: vary sentence structure and word choice (synonyms, reordering, " +
      "a fresh opening line). This SHOULD read noticeably different from the original wording.\n" +
      "- Keep the SAME meaning, tone, and every concrete fact: numbers, prices, city/market names, and property details.\n" +
      "- Preserve existing emojis (you may move them to fit the new wording) but do NOT add brand-new emojis.\n" +
      "- NEVER change any call-to-action. Keep CTAs verbatim (e.g. 'comment INFO', 'COMMENT \"SA\"', " +
      "'FILL OUT THE LINK IN BIO', phone numbers). Per brand policy, prefer 'Comment' CTAs; do NOT convert a " +
      "'Comment' CTA into a 'DM' CTA.\n" +
      "- NEVER add or remove hashtags.\n" +
      "- Keep a similar overall length and line-break structure.\n" +
      "- Return ONLY the rewritten caption body. No hashtags. No commentary.\n\n" +
      "CAPTION BODY:\n" +
      body;

    const res = await invokeLLM({
      model: CAPTION_MODEL,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1200,
    });

    const raw = res.choices?.[0]?.message?.content;
    const newBody = typeof raw === "string" ? raw.trim() : "";

    // Safety: reject empty output or any output that introduced hashtags in the
    // body. Hashtags always come from the untouched `tags` block below.
    if (!newBody || newBody.includes("#")) {
      return caption;
    }
    // Re-attach the ORIGINAL hashtag block verbatim — hashtags are never altered.
    return tags ? `${newBody.replace(/\s+$/, "")}\n\n${tags}` : newBody;
  } catch (err) {
    console.error("[captionRefresh] LLM failed, using original:", err);
    return caption;
  }
}
