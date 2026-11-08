import type { CloudFile } from "@libretracks/shared/desktopApi";
import { parsePackageFileName, type ParsedPackageName } from "../transport/cloud/packageNaming";
import { isMusicalSong } from "./stageSession";
import type { WTSong } from "./wtApi";

export type SongCloudMatch = {
  song: WTSong;
  rowKey: string;
  isMusical: boolean;
  hasMatch: boolean;
  bestMatch: CloudFile | null;
  bestParsedMeta: ParsedPackageName | null;
  allMatches: CloudFile[];
  keyMatches: boolean;
};

export type SetlistCloudMatchResult = {
  totalMusical: number;
  foundCount: number;
  missingCount: number;
  percentFound: number;
  items: SongCloudMatch[];
  matchedMap: Map<string, SongCloudMatch>;
};

/**
 * Normalizes text by removing diacritics/accents, lowercasing, and stripping
 * punctuation.
 */
export function normalizeTitle(text: string): string {
  if (!text) return "";
  return text
    .replace(/\.(ltpkg|ltset|wav|mp3|m4a|aac|ogg|flac)$/i, "")
    .replace(/\s*\[.*?\]\s*$/, "") // strip bracketed tags like [120bpm Am 4-4]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .toLowerCase()
    .replace(/['’`]/g, "") // don't -> dont
    .replace(/[^a-z0-9\s]/g, " ") // punctuation to space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips secondary parenthetical subtitles, e.g. "Oceans (Where Feet May Fail)" -> "Oceans".
 */
export function extractCoreTitle(text: string): string {
  const withoutParens = text.replace(/\(.*?\)/g, " ").replace(/\[.*?\]/g, " ");
  return normalizeTitle(withoutParens);
}

/**
 * Splits combined titles like "Wat een mooie naam / What A Beautiful Name".
 */
function splitAlternateTitles(text: string): string[] {
  return text
    .split(/\s*[\/|]\s*/)
    .map(normalizeTitle)
    .filter(Boolean);
}

/**
 * Normalizes musical key string for comparison (e.g. "C#m", "Dbm", "G").
 */
function normalizeKey(key?: string | null): string | null {
  if (!key) return null;
  const clean = key.trim();
  if (clean === "—" || clean === "-" || clean === "") return null;
  return clean.toLowerCase();
}

/**
 * Computes a match score between a setlist song and a cloud file.
 * Returns 0 if not a match, or a positive score where higher is a better match.
 */
export function scoreCloudMatch(song: WTSong, file: CloudFile): { score: number; meta: ParsedPackageName } {
  const meta = parsePackageFileName(file.name);
  const cloudNorm = normalizeTitle(meta.title || file.name);
  const cloudCore = extractCoreTitle(meta.title || file.name);

  if (!cloudNorm) return { score: 0, meta };

  const songNorm = normalizeTitle(song.title);
  const songCore = extractCoreTitle(song.title);
  const songAlts = splitAlternateTitles(song.title);

  let baseScore = 0;

  // 1. Exact match on normalized full title
  if (songNorm === cloudNorm) {
    baseScore = 100;
  }
  // 2. Exact match on core title (ignoring parentheses)
  else if (songCore && cloudCore && songCore === cloudCore) {
    baseScore = 90;
  }
  // 3. Cross match core with full
  else if ((songCore && songCore === cloudNorm) || (cloudCore && cloudCore === songNorm)) {
    baseScore = 85;
  }
  // 4. Alternate titles match (e.g. split by '/')
  else {
    const matchedAlt = songAlts.some((alt) => alt === cloudNorm || (cloudCore && alt === cloudCore));
    if (matchedAlt) {
      baseScore = 80;
    } else {
      // 5. Word boundary / substring containment for titles >= 4 chars
      if (
        songCore.length >= 4 &&
        cloudCore.length >= 4 &&
        (cloudNorm.startsWith(songCore) ||
          songNorm.startsWith(cloudCore) ||
          ` ${cloudNorm} `.includes(` ${songCore} `) ||
          ` ${songNorm} `.includes(` ${cloudCore} `))
      ) {
        baseScore = 60;
      }
    }
  }

  if (baseScore === 0) {
    return { score: 0, meta };
  }

  // Bonus points for musical key match
  const songKeyNorm = normalizeKey(song.key);
  const cloudKeyNorm = normalizeKey(meta.key);
  if (songKeyNorm && cloudKeyNorm && songKeyNorm === cloudKeyNorm) {
    baseScore += 20;
  }

  // Bonus points for tempo proximity if both available
  if (typeof song.bpm === "number" && typeof meta.bpm === "number") {
    if (Math.abs(song.bpm - meta.bpm) <= 2) {
      baseScore += 5;
    }
  }

  return { score: baseScore, meta };
}

/**
 * Matches a setlist against a list of cloud files.
 */
export function matchSetlistWithCloud(
  songs: WTSong[],
  cloudFiles: CloudFile[],
  serviceId: string,
): SetlistCloudMatchResult {
  const items: SongCloudMatch[] = [];
  const matchedMap = new Map<string, SongCloudMatch>();

  let totalMusical = 0;
  let foundCount = 0;

  songs.forEach((song, index) => {
    const rowKey = `${serviceId}:${song.cueId ?? song.songId ?? index}`;
    const musical = isMusicalSong(song);

    if (musical) {
      totalMusical++;
    }

    if (!musical) {
      const matchItem: SongCloudMatch = {
        song,
        rowKey,
        isMusical: false,
        hasMatch: false,
        bestMatch: null,
        bestParsedMeta: null,
        allMatches: [],
        keyMatches: false,
      };
      items.push(matchItem);
      matchedMap.set(rowKey, matchItem);
      return;
    }

    // Find all matching cloud files scored
    const scoredFiles: Array<{ file: CloudFile; score: number; meta: ParsedPackageName }> = [];
    for (const file of cloudFiles) {
      const { score, meta } = scoreCloudMatch(song, file);
      if (score > 0) {
        scoredFiles.push({ file, score, meta });
      }
    }

    // Sort by highest score first, then newest modified date
    scoredFiles.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.file.modified || "").localeCompare(a.file.modified || "");
    });

    const hasMatch = scoredFiles.length > 0;
    if (hasMatch) {
      foundCount++;
    }

    const best = scoredFiles[0] ?? null;
    const songKeyNorm = normalizeKey(song.key);
    const bestKeyNorm = best ? normalizeKey(best.meta.key) : null;
    const keyMatches = Boolean(songKeyNorm && bestKeyNorm && songKeyNorm === bestKeyNorm);

    const matchItem: SongCloudMatch = {
      song,
      rowKey,
      isMusical: true,
      hasMatch,
      bestMatch: best ? best.file : null,
      bestParsedMeta: best ? best.meta : null,
      allMatches: scoredFiles.map((s) => s.file),
      keyMatches,
    };

    items.push(matchItem);
    matchedMap.set(rowKey, matchItem);
  });

  const missingCount = totalMusical - foundCount;
  const percentFound = totalMusical > 0 ? Math.round((foundCount / totalMusical) * 100) : 0;

  return {
    totalMusical,
    foundCount,
    missingCount,
    percentFound,
    items,
    matchedMap,
  };
}
