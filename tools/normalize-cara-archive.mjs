import fs from "node:fs";
import path from "node:path";

const WORKSPACE = process.cwd();
const EXPORT_ROOT = path.join(
  WORKSPACE,
  "resources",
  "instagram-justelson-2026-04-30-vKrKn5QO",
);
const THREAD_ID = "cara_17848691634621094";
const THREAD_REL = path.join(
  "your_instagram_activity",
  "messages",
  "inbox",
  THREAD_ID,
);
const THREAD_ROOT = path.join(EXPORT_ROOT, THREAD_REL);
const THREAD_HTML = path.join(THREAD_ROOT, "message_1.html");
const OUTPUT_ROOT = path.join(WORKSPACE, "resources", "cara-analysis");
const DATA_ROOT = path.join(OUTPUT_ROOT, "data");
const LEDGER = path.join(OUTPUT_ROOT, "run-ledger.md");

const MONTHS = new Map([
  ["Jan", "01"],
  ["Feb", "02"],
  ["Mar", "03"],
  ["Apr", "04"],
  ["May", "05"],
  ["Jun", "06"],
  ["Jul", "07"],
  ["Aug", "08"],
  ["Sep", "09"],
  ["Oct", "10"],
  ["Nov", "11"],
  ["Dec", "12"],
]);

const HTML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#039", "'"],
  ["nbsp", " "],
]);

const MEDIA_EXTENSIONS = new Map([
  [".jpg", "image"],
  [".jpeg", "image"],
  [".png", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".mp4", "video"],
  [".mov", "video"],
  [".m4v", "video"],
  [".ogg", "audio"],
  [".oga", "audio"],
  [".mp3", "audio"],
  [".m4a", "audio"],
  [".wav", "audio"],
]);

function ensureDirs() {
  for (const dir of [OUTPUT_ROOT, DATA_ROOT, path.join(OUTPUT_ROOT, "analysis"), path.join(OUTPUT_ROOT, "design")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function relFromWorkspace(absPath) {
  return path.relative(WORKSPACE, absPath).replaceAll(path.sep, "/");
}

function relFromExport(absPath) {
  return path.relative(EXPORT_ROOT, absPath).replaceAll(path.sep, "/");
}

function decodeHtml(value) {
  if (!value) return "";
  return value.replace(/&([a-zA-Z]+|#[0-9]+|#x[0-9a-fA-F]+);/g, (match, entity) => {
    if (HTML_ENTITIES.has(entity)) return HTML_ENTITIES.get(entity);
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripTags(html) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\r/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function textOneLine(html) {
  return stripTags(html).replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function allMatches(regex, text, group = 1) {
  return [...text.matchAll(regex)].map((match) => decodeHtml(match[group] ?? ""));
}

function parseTimestamp(raw) {
  const match = raw.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(am|pm)$/i);
  if (!match) return null;
  const [, mon, d, y, h, min, ampm] = match;
  const month = MONTHS.get(mon);
  if (!month) return null;
  let hour = Number.parseInt(h, 10);
  if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
  return `${y}-${month}-${String(Number.parseInt(d, 10)).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${min}:00+03:00`;
}

function dateKey(iso) {
  return iso?.slice(0, 10) ?? null;
}

function classifyUrl(url) {
  if (/instagram\.com\/reel\//i.test(url)) return "instagram_reel";
  if (/instagram\.com\/p\//i.test(url)) return "instagram_post";
  if (/instagram\.com\/stories\//i.test(url)) return "instagram_story";
  if (/instagram\.com\//i.test(url)) return "instagram_other";
  return "external";
}

function extractInstagramShortcode(url) {
  const match = url.match(/instagram\.com\/(?:reel|p)\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

function localMediaPathFromSrc(src) {
  if (!src || /^https?:\/\//i.test(src) || src.startsWith("data:")) return null;
  const normalized = src.replaceAll("\\", "/").replace(/^\.?\//, "");
  const abs = path.join(EXPORT_ROOT, ...normalized.split("/"));
  return fs.existsSync(abs) ? abs : path.join(EXPORT_ROOT, normalized);
}

function attachmentTypeFromPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/messages/inbox/") && normalized.includes("/audio/")) return "audio";
  if (normalized.includes("/messages/inbox/") && normalized.includes("/videos/")) return "video";
  if (normalized.includes("/messages/inbox/") && normalized.includes("/photos/")) return "image";
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.get(ext) ?? sniffMediaType(filePath);
}

function sniffMediaType(filePath) {
  if (!fs.existsSync(filePath)) return "file";
  const bytes = fs.readFileSync(filePath, { encoding: null }).subarray(0, 16);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video";
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "audio";
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "audio";
  return "file";
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else out.push(next);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function getThreadTitle(html) {
  return decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? THREAD_ID);
}

function splitMessageBlocks(html) {
  const marker = '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">';
  return html
    .split(marker)
    .slice(1)
    .map((part) => marker + part)
    .filter((part) => /<h2\b/i.test(part) && /class="_3-94 _a6-o"/i.test(part));
}

function parseMessageBlock(block, sourceIndex, threadTitle) {
  const sender = textOneLine(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "") || "unknown";
  const timestampOriginal = textOneLine(block.match(/<div class="_3-94 _a6-o">([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const timestampIso = parseTimestamp(timestampOriginal);
  const payloadHtml =
    block.match(/<div class="_3-95 _a6-p">([\s\S]*?)<div class="_3-94 _a6-o">/i)?.[1] ?? "";

  const reactions = allMatches(/<ul class="_a6-q">([\s\S]*?)<\/ul>/gi, payloadHtml).map(textOneLine);
  const payloadWithoutReactions = payloadHtml.replace(/<ul class="_a6-q">[\s\S]*?<\/ul>/gi, "");
  const links = unique(allMatches(/<a\b[^>]*href="([^"]+)"/gi, payloadHtml));
  const srcs = unique(allMatches(/\b(?:src|poster)="([^"]+)"/gi, payloadHtml));

  const attachments = srcs
    .map((src) => {
      const localAbs = localMediaPathFromSrc(src);
      if (!localAbs) return null;
      const exists = fs.existsSync(localAbs);
      return {
        type: attachmentTypeFromPath(localAbs),
        src,
        path: relFromExport(localAbs),
        workspace_path: relFromWorkspace(localAbs),
        exists,
        bytes: exists ? fs.statSync(localAbs).size : null,
      };
    })
    .filter(Boolean);

  const visibleText = stripTags(payloadWithoutReactions)
    .split("\n")
    .filter((line) => !links.includes(line.trim()))
    .join("\n")
    .trim();

  return {
    message_id: `cara-msg-src-${String(sourceIndex).padStart(5, "0")}`,
    thread_id: THREAD_ID,
    thread_title: threadTitle,
    sender,
    timestamp_original: timestampOriginal,
    timestamp_iso: timestampIso,
    timestamp_date: dateKey(timestampIso),
    text: visibleText || null,
    attachments,
    links,
    reel_ids: [],
    reply_context: null,
    reactions,
    source_file: relFromWorkspace(THREAD_HTML),
    source_index: sourceIndex,
  };
}

function buildReelAndLinkIndexes(messages) {
  const links = [];
  const reels = [];
  let reelCounter = 0;

  for (const message of messages) {
    for (const [linkIndex, url] of message.links.entries()) {
      const type = classifyUrl(url);
      const shortcode = extractInstagramShortcode(url);
      const linkId = `cara-link-${String(links.length + 1).padStart(5, "0")}`;
      links.push({
        link_id: linkId,
        message_id: message.message_id,
        timestamp_iso: message.timestamp_iso,
        sender: message.sender,
        url,
        type,
        shortcode,
        source_index: message.source_index,
        link_index: linkIndex,
      });

      if (type === "instagram_reel") {
        reelCounter += 1;
        const stamp = (message.timestamp_iso ?? "unknown-date")
          .replace(/[-:]/g, "")
          .replace("T", "-")
          .replace(/\+.*/, "");
        const reelId = `cara-reel-${stamp}-${String(reelCounter).padStart(3, "0")}`;
        message.reel_ids.push(reelId);
        reels.push({
          reel_id: reelId,
          message_id: message.message_id,
          timestamp_iso: message.timestamp_iso,
          sender: message.sender,
          url,
          shortcode,
          burst_id: null,
          local_video_path: null,
          local_thumbnail_path: null,
          frames_path: null,
          audio_path: null,
          transcript_path: null,
          fetch_status: "not_attempted",
          fetch_method: "none",
          caption_or_title: null,
          visual_summary: null,
          audio_summary: null,
          gesture_read: null,
          usefulness: "medium",
          confidence: "observed",
          evidence_notes: [
            `Shared in message ${message.message_id}`,
            message.text ? `Context text present: ${message.text.slice(0, 120)}` : "No surrounding text in same message",
          ],
        });
      }
    }
  }

  return { links, reels };
}

function minutesBetween(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs((Date.parse(a) - Date.parse(b)) / 60000);
}

function assignReelBursts(reels, messagesById) {
  const chronological = [...reels].sort((a, b) => Date.parse(a.timestamp_iso ?? 0) - Date.parse(b.timestamp_iso ?? 0));
  const bursts = [];
  let current = [];

  const flush = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    const burstId = `cara-reel-burst-${String(bursts.length + 1).padStart(4, "0")}`;
    for (const reel of current) reel.burst_id = burstId;
    bursts.push({
      burst_id: burstId,
      start_timestamp_iso: current[0].timestamp_iso,
      end_timestamp_iso: current[current.length - 1].timestamp_iso,
      sender: current[0].sender,
      reel_ids: current.map((reel) => reel.reel_id),
      message_ids: current.map((reel) => reel.message_id),
      count: current.length,
      context_before_message_id: previousNonReelMessageId(current[0], messagesById),
      context_after_message_id: nextNonReelMessageId(current[current.length - 1], messagesById),
      first_pass_read: "Consecutive reel/link burst; needs surrounding-context interpretation before any public fetch.",
      confidence: "observed",
    });
    current = [];
  };

  for (const reel of chronological) {
    const prior = current[current.length - 1];
    const sameSender = !prior || prior.sender === reel.sender;
    const closeEnough = !prior || minutesBetween(prior.timestamp_iso, reel.timestamp_iso) <= 20;
    const sourceGap = !prior || Math.abs(messagesById.get(prior.message_id).conversation_index - messagesById.get(reel.message_id).conversation_index) <= 3;
    if (sameSender && closeEnough && sourceGap) current.push(reel);
    else {
      flush();
      current.push(reel);
    }
  }
  flush();
  return bursts;
}

function previousNonReelMessageId(reel, messagesById) {
  const message = messagesById.get(reel.message_id);
  if (!message) return null;
  const messages = [...messagesById.values()].sort((a, b) => a.conversation_index - b.conversation_index);
  for (let i = message.conversation_index - 1; i >= 0; i -= 1) {
    if (!messages[i]?.reel_ids?.length) return messages[i]?.message_id ?? null;
  }
  return null;
}

function nextNonReelMessageId(reel, messagesById) {
  const message = messagesById.get(reel.message_id);
  if (!message) return null;
  const messages = [...messagesById.values()].sort((a, b) => a.conversation_index - b.conversation_index);
  for (let i = message.conversation_index + 1; i < messages.length; i += 1) {
    if (!messages[i]?.reel_ids?.length) return messages[i]?.message_id ?? null;
  }
  return null;
}

function buildLocalMediaIndex(messages) {
  const byPath = new Map();
  for (const message of messages) {
    for (const attachment of message.attachments) {
      byPath.set(attachment.path, {
        media_id: `cara-media-${String(byPath.size + 1).padStart(5, "0")}`,
        message_id: message.message_id,
        timestamp_iso: message.timestamp_iso,
        sender: message.sender,
        type: attachment.type,
        path: attachment.path,
        workspace_path: attachment.workspace_path,
        bytes: attachment.bytes,
        referenced_in_html: true,
        source: "message_html",
      });
    }
  }

  for (const abs of walkFiles(THREAD_ROOT)) {
    if (abs === THREAD_HTML) continue;
    const ext = path.extname(abs).toLowerCase();
    const type = MEDIA_EXTENSIONS.get(ext) ?? "file";
    const rel = relFromExport(abs);
    if (!byPath.has(rel)) {
      byPath.set(rel, {
        media_id: `cara-media-${String(byPath.size + 1).padStart(5, "0")}`,
        message_id: null,
        timestamp_iso: null,
        sender: null,
        type,
        path: rel,
        workspace_path: relFromWorkspace(abs),
        bytes: fs.statSync(abs).size,
        referenced_in_html: false,
        source: "thread_folder_scan",
      });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function writeJsonl(fileName, rows) {
  fs.writeFileSync(
    path.join(DATA_ROOT, fileName),
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    "utf8",
  );
}

function summarizeByDay(messages) {
  const byDay = new Map();
  for (const message of messages) {
    const day = message.timestamp_date ?? "unknown";
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, messages: 0, justelson: 0, cara: 0, links: 0, reels: 0, attachments: 0 });
    }
    const bucket = byDay.get(day);
    bucket.messages += 1;
    if (message.sender === "justelson") bucket.justelson += 1;
    else if (message.sender.startsWith("Cara")) bucket.cara += 1;
    bucket.links += message.links.length;
    bucket.reels += message.reel_ids.length;
    bucket.attachments += message.attachments.length;
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function chunkProposal(dayStats) {
  return dayStats.map((day) => {
    let proposed_chunk = "weekly";
    if (day.date >= "2026-04-01") {
      proposed_chunk = day.messages >= 250 ? "daily" : day.messages >= 80 ? "1-2 days" : "2-3 days";
    }
    return { ...day, proposed_chunk };
  });
}

function activityGaps(dayStats) {
  const gaps = [];
  for (let i = 1; i < dayStats.length; i += 1) {
    const previous = dayStats[i - 1];
    const current = dayStats[i];
    if (!previous?.date || !current?.date || previous.date === "unknown" || current.date === "unknown") continue;
    const quietDays = Math.round(
      (Date.parse(`${current.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) / 86400000,
    ) - 1;
    if (quietDays > 0) {
      gaps.push({
        gap_id: `cara-gap-${String(gaps.length + 1).padStart(4, "0")}`,
        from_active_date: previous.date,
        to_active_date: current.date,
        quiet_days: quietDays,
        confidence: "observed",
        evidence_notes: [
          `No message dates found between ${previous.date} and ${current.date} in normalized export.`,
        ],
      });
    }
  }
  return gaps;
}

function appendLedger(summary, paths) {
  const now = new Date().toISOString();
  const content = `# Cara Archive Run Ledger

## ${now} - First-pass normalization

- Created analysis workspace at \`resources/cara-analysis\`.
- Parsed \`${relFromWorkspace(THREAD_HTML)}\`.
- Wrote normalized message, link, reel, burst, media, image, audio, daily-count, and chunk-proposal JSONL files.
- Timestamp note: Instagram export timestamps have no explicit timezone; first pass stores them as \`+03:00\` using the current project/environment timezone context.
- Safety note: no Instagram cookies, account automation, public fetching, or raw-export mutation occurred.

### Counts

- Messages: ${summary.messages}
- Senders: ${Object.entries(summary.senderCounts)
    .map(([sender, count]) => `${sender} ${count}`)
    .join(", ")}
- Links: ${summary.links}
- Instagram reels: ${summary.reels}
- Reel bursts: ${summary.bursts}
- Referenced/local media files: ${summary.media}
- Images: ${summary.images}
- Video files: ${summary.videos}
- Audio files: ${summary.audio}
- Date range: ${summary.firstTimestampOriginal} to ${summary.lastTimestampOriginal}

### Files Produced

${paths.map((file) => `- \`${relFromWorkspace(file)}\``).join("\n")}

### Next

- Review dense dates and split date chunks for subagents.
- Rank reels by surrounding context before any public unauthenticated fetch.
- Inspect local images/video/audio from the export before touching external sources.
`;
  if (fs.existsSync(LEDGER)) {
    fs.appendFileSync(LEDGER, `\n\n${content}`, "utf8");
  } else {
    fs.writeFileSync(LEDGER, content, "utf8");
  }
}

function main() {
  ensureDirs();
  const html = fs.readFileSync(THREAD_HTML, "utf8");
  const threadTitle = getThreadTitle(html);
  const blocks = splitMessageBlocks(html);
  const latestFirst = blocks.map((block, index) => parseMessageBlock(block, index, threadTitle));
  const chronological = [...latestFirst]
    .reverse()
    .map((message, index) => ({ ...message, conversation_index: index }));

  const { links, reels } = buildReelAndLinkIndexes(chronological);
  const messagesById = new Map(chronological.map((message) => [message.message_id, message]));
  const bursts = assignReelBursts(reels, messagesById);
  const media = buildLocalMediaIndex(chronological);
  const images = media.filter((item) => item.type === "image");
  const audio = media.filter((item) => item.type === "audio");
  const videos = media.filter((item) => item.type === "video");
  const dayStats = summarizeByDay(chronological);
  const chunks = chunkProposal(dayStats);
  const gaps = activityGaps(dayStats);

  const outputFiles = [
    ["messages.normalized.jsonl", chronological],
    ["links.index.jsonl", links],
    ["reels.index.jsonl", reels],
    ["reel-bursts.index.jsonl", bursts],
    ["media.index.jsonl", media],
    ["images.index.jsonl", images],
    ["audio.index.jsonl", audio],
    ["audio.transcripts.jsonl", []],
    ["timeline.events.jsonl", []],
    ["themes.index.jsonl", []],
    ["daily-counts.jsonl", dayStats],
    ["chunk-proposal.jsonl", chunks],
    ["activity-gaps.jsonl", gaps],
  ];
  for (const [name, rows] of outputFiles) writeJsonl(name, rows);

  const senderCounts = {};
  for (const message of chronological) senderCounts[message.sender] = (senderCounts[message.sender] ?? 0) + 1;
  const summary = {
    threadTitle,
    messages: chronological.length,
    senderCounts,
    links: links.length,
    reels: reels.length,
    bursts: bursts.length,
    media: media.length,
    images: images.length,
    videos: videos.length,
    audio: audio.length,
    firstTimestampOriginal: chronological[0]?.timestamp_original ?? null,
    lastTimestampOriginal: chronological.at(-1)?.timestamp_original ?? null,
    firstTimestampIso: chronological[0]?.timestamp_iso ?? null,
    lastTimestampIso: chronological.at(-1)?.timestamp_iso ?? null,
    denseDates: [...chunks].sort((a, b) => b.messages - a.messages).slice(0, 12),
    outputFiles: outputFiles.map(([name]) => relFromWorkspace(path.join(DATA_ROOT, name))),
  };

  fs.writeFileSync(path.join(DATA_ROOT, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  appendLedger(summary, outputFiles.map(([name]) => path.join(DATA_ROOT, name)));

  console.log(JSON.stringify(summary, null, 2));
}

main();
