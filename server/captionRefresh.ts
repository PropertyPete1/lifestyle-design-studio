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
      "You lightly refresh an Instagram real-estate caption so a reposted reel does not look identical to the original.\n" +
      "STRICT RULES:\n" +
      "- Change only a FEW words in the FIRST line or two (synonyms / tiny reorder).\n" +
      "- Keep the rest of the description, emojis, numbers, prices, and meaning the SAME.\n" +
      "- NEVER change any call-to-action (e.g. 'comment INFO', 'DM LIST', 'FILL OUT THE LINK IN BIO').\n" +
      "- NEVER add or remove hashtags. Do NOT add new emojis.\n" +
      "- Keep the same line breaks and structure.\n" +
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

    // Safety: reject empty output or any output that introduced hashtags.
    if (!newBody || newBody.includes("#")) {
      return caption;
    }
    return tags ? `${newBody.replace(/\s+$/, "")}\n\n${tags}` : newBody;
  } catch (err) {
    console.error("[captionRefresh] LLM failed, using original:", err);
    return caption;
  }
}
