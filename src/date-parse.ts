import { requestUrl } from "obsidian";
import * as chrono from "chrono-node";
import type { App } from "obsidian";

interface RelayApi {
  request(
    body: unknown,
    opts?: { callerId?: string; priority?: number },
  ): Promise<{ content?: { type: string; text?: string }[] }>;
}

export interface ParsedDateTime {
  date: string;
  time: string | null;
}

export interface ParseOptions {
  /** Exact-match phrases mapped to a special date value (e.g. "asap" → "Immediately"). */
  specialPhrases?: Record<string, string>;
  /** Extra instruction appended to the Claude prompt for fuzzy special-phrase matching. */
  claudeExtraPrompt?: string;
  callerId?: string;
  /** Direct Anthropic API key — used when the relay is unavailable. */
  anthropicApiKey?: string;
}

function getRelay(app: App): RelayApi | null {
  return (app as unknown as { irisRelay?: RelayApi }).irisRelay ?? null;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function expandShortcuts(input: string): string {
  return input
    .replace(/\beod\b/gi, "end of day")
    .replace(/\beow\b/gi, "end of this week")
    .replace(/\beom\b/gi, "end of this month")
    .replace(/\bbod\b/gi, "start of day")
    .replace(/\bbow\b/gi, "start of this week");
}

export async function parseNLDateTime(
  app: App,
  input: string,
  opts?: ParseOptions,
): Promise<ParsedDateTime | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (opts?.specialPhrases) {
    for (const [phrase, value] of Object.entries(opts.specialPhrases)) {
      if (lower === phrase) return { date: value, time: null };
    }
  }

  const expanded = expandShortcuts(trimmed);
  const results = chrono.parse(expanded);
  if (results.length > 0) {
    const start = results[0].start;
    const parsed = start.date();
    let time: string | null = null;
    if (start.isCertain("hour")) {
      const hh = String(parsed.getHours()).padStart(2, "0");
      const mm = String(parsed.getMinutes()).padStart(2, "0");
      time = `${hh}:${mm}`;
    }
    return { date: formatDate(parsed), time };
  }

  const relay = getRelay(app);
  const apiKey = opts?.anthropicApiKey;
  if (!relay && !apiKey) return null;

  try {
    const todayStr = formatDate(new Date());
    const extra = opts?.claudeExtraPrompt ? " " + opts.claudeExtraPrompt : "";
    const requestBody = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content:
            `Today is ${todayStr}. Parse this into a date and optional time. ` +
            `Return ONLY valid JSON: {"date":"YYYY-MM-DD","time":"HH:mm"} or {"date":"YYYY-MM-DD","time":null}.` +
            `${extra} Input: "${trimmed}"`,
        },
      ],
    };

    let text: string;
    if (relay) {
      const json = await relay.request(requestBody, {
        callerId: opts?.callerId ?? "iris-calendar",
        priority: 1,
      });
      text = json?.content?.[0]?.text ?? "";
    } else {
      const response = await Promise.race([
        requestUrl({
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "x-api-key": apiKey!,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Date parsing timed out")), 15_000),
        ),
      ]);
      if (response.status >= 400) return null;
      text = response.json?.content?.[0]?.text ?? "";
    }

    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);

    const validSpecial = opts?.specialPhrases
      ? new Set(Object.values(opts.specialPhrases))
      : new Set<string>();
    if (
      !obj.date ||
      (!/^\d{4}-\d{2}-\d{2}$/.test(obj.date) && !validSpecial.has(obj.date))
    ) {
      return null;
    }
    return { date: obj.date, time: obj.time || null };
  } catch (e) {
    console.error(`[${opts?.callerId ?? "iris-calendar"}] date parsing failed`, e);
    return null;
  }
}
