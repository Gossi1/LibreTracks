import { describe, expect, it } from "vitest";
import type { CloudFile } from "@libretracks/shared/desktopApi";
import {
  extractCoreTitle,
  matchSetlistWithCloud,
  normalizeTitle,
  scoreCloudMatch,
} from "./setlistCloudMatcher";
import type { WTSong } from "./wtApi";

describe("setlistCloudMatcher", () => {
  describe("normalizeTitle & extractCoreTitle", () => {
    it("normalizes casing, accents and extensions", () => {
      expect(normalizeTitle("Cuán grande es Dios.ltpkg")).toBe("cuan grande es dios");
      expect(normalizeTitle("Way Maker [68bpm E 4-4].ltpkg")).toBe("way maker");
      expect(normalizeTitle("Don't You Worry.wav")).toBe("dont you worry");
    });

    it("extracts core title without parentheses or brackets", () => {
      expect(extractCoreTitle("Oceans (Where Feet May Fail)")).toBe("oceans");
      expect(extractCoreTitle("What A Beautiful Name (Live)")).toBe("what a beautiful name");
    });
  });

  describe("scoreCloudMatch", () => {
    const cloudFile = (name: string): CloudFile => ({
      id: "f1",
      name,
      sizeBytes: 1000,
      modified: "2026-10-01T00:00:00Z",
    });

    it("scores exact matches higher than subtitle matches", () => {
      const song: WTSong = { title: "Way Maker", key: "E", bpm: 68, meter: "4/4" };
      const exact = scoreCloudMatch(song, cloudFile("Way Maker.ltpkg"));
      const partial = scoreCloudMatch(song, cloudFile("Way Maker (Live).ltpkg"));

      expect(exact.score).toBeGreaterThan(0);
      expect(partial.score).toBeGreaterThan(0);
      expect(exact.score).toBeGreaterThan(partial.score);
    });

    it("adds bonus score for matching key", () => {
      const song: WTSong = { title: "Way Maker", key: "E", bpm: 68, meter: "4/4" };
      const withKey = scoreCloudMatch(song, cloudFile("Way Maker [68bpm E 4-4].ltpkg"));
      const withDiffKey = scoreCloudMatch(song, cloudFile("Way Maker [68bpm D 4-4].ltpkg"));

      expect(withKey.score).toBeGreaterThan(withDiffKey.score);
    });

    it("matches slash separated titles", () => {
      const song: WTSong = { title: "Wat een mooie naam / What A Beautiful Name", key: "D", bpm: 68, meter: "4/4" };
      const match = scoreCloudMatch(song, cloudFile("What A Beautiful Name [68bpm D].ltpkg"));
      expect(match.score).toBeGreaterThan(0);
    });
  });

  describe("matchSetlistWithCloud", () => {
    it("correctly identifies which songs are in the cloud and which are missing", () => {
      const songs: WTSong[] = [
        { title: "Way Maker", key: "E", bpm: 68, meter: "4/4", position: 1, songId: "s1" },
        { title: "Gebed", key: "—", bpm: null, meter: "4/4", position: 2, cueId: "c2" }, // non-musical cue
        { title: "Oceans (Where Feet May Fail)", key: "D", bpm: 130, meter: "4/4", position: 3, songId: "s3" },
        { title: "Onbekend Lied", key: "G", bpm: 100, meter: "4/4", position: 4, songId: "s4" }, // missing
      ];

      const cloudFiles: CloudFile[] = [
        {
          id: "f-way-maker",
          name: "Way Maker [68bpm E 4-4].ltpkg",
          sizeBytes: 5000000,
          modified: "2026-10-10T12:00:00Z",
        },
        {
          id: "f-oceans",
          name: "Oceans [130bpm D 4-4].ltpkg",
          sizeBytes: 6000000,
          modified: "2026-10-12T12:00:00Z",
        },
        {
          id: "f-other",
          name: "Graves Into Gardens [70bpm B 4-4].ltpkg",
          sizeBytes: 4000000,
          modified: "2026-10-01T12:00:00Z",
        },
      ];

      const result = matchSetlistWithCloud(songs, cloudFiles, "svc-1");

      // 3 musical songs total
      expect(result.totalMusical).toBe(3);
      // 2 songs found in cloud (Way Maker & Oceans)
      expect(result.foundCount).toBe(2);
      // 1 missing (Onbekend Lied)
      expect(result.missingCount).toBe(1);
      expect(result.percentFound).toBe(67);

      const wayMaker = result.items[0];
      expect(wayMaker?.isMusical).toBe(true);
      expect(wayMaker?.hasMatch).toBe(true);
      expect(wayMaker?.bestMatch?.name).toBe("Way Maker [68bpm E 4-4].ltpkg");
      expect(wayMaker?.keyMatches).toBe(true);

      const gebed = result.items[1];
      expect(gebed?.isMusical).toBe(false);
      expect(gebed?.hasMatch).toBe(false);

      const oceans = result.items[2];
      expect(oceans?.isMusical).toBe(true);
      expect(oceans?.hasMatch).toBe(true);
      expect(oceans?.bestMatch?.name).toBe("Oceans [130bpm D 4-4].ltpkg");

      const onbekend = result.items[3];
      expect(onbekend?.isMusical).toBe(true);
      expect(onbekend?.hasMatch).toBe(false);
      expect(onbekend?.bestMatch).toBeNull();
    });
  });
});
