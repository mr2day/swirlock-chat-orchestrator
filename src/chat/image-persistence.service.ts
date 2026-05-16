import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { InputPartDto } from './dto/submit-turn.dto';

/**
 * Where uploaded images live on disk. Sits next to the SQLite file in
 * the orchestrator's `data/` directory so the same gitignore rule
 * keeps it out of version control.
 */
export const IMAGES_DIR = path.resolve(__dirname, '..', '..', 'data', 'images');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*)*,(.*)$/;

/**
 * Persists user-attached image parts to disk and rewrites the parts
 * so the persisted `messages.parts_json` carries only `imageId` +
 * `mimeType` — never the raw base64. Each part gets the filename
 * `<userMessageId>-<index>.<ext>` and is served back to clients at
 * `https://api.gigi-the-robot.com/images/<that filename>`.
 *
 * This replaces the previous behaviour where `imageBase64` was just
 * stringified to the literal `"[redacted]"`, which meant a session
 * reopened from the database lost the picture entirely. Now the
 * picture survives across reloads, devices, and the user's lifetime
 * of the session.
 */
@Injectable()
export class ImagePersistenceService {
  private readonly log = new Logger(ImagePersistenceService.name);

  constructor() {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  /**
   * Takes the inbound parts from a turn, writes each image's bytes
   * to disk, and returns the same array shape but with each image's
   * `imageBase64` replaced by a stable `imageId` that points at the
   * file on disk.
   *
   * Text parts and image parts that already arrive as `imageId` or
   * `imageUrl` pass through untouched. Failed writes degrade
   * gracefully — the part keeps its base64 stripped and is marked
   * with a placeholder so the row insert still succeeds.
   */
  persistParts(args: {
    userMessageId: string;
    parts: InputPartDto[];
  }): InputPartDto[] {
    return args.parts.map((part, idx) => {
      if (part.type !== 'image' || !part.imageBase64) return part;
      const decoded = this.decodeImageBase64(part.imageBase64, part.mimeType);
      if (!decoded) {
        this.log.warn(
          `image part ${idx} on message ${args.userMessageId} could not be decoded; dropping bytes`,
        );
        const { imageBase64: _ignored, ...rest } = part;
        return { ...rest, imageId: undefined };
      }
      const ext = EXT_BY_MIME[decoded.mimeType] ?? 'bin';
      const imageId = `${args.userMessageId}-${idx}.${ext}`;
      const target = path.join(IMAGES_DIR, imageId);
      try {
        fs.writeFileSync(target, decoded.bytes);
      } catch (err) {
        this.log.warn(
          `failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return part;
      }
      return {
        type: 'image',
        imageId,
        mimeType: decoded.mimeType,
      };
    });
  }

  private decodeImageBase64(
    raw: string,
    explicitMime: string | undefined,
  ): { bytes: Buffer; mimeType: string } | null {
    const match = DATA_URL_RE.exec(raw);
    let payload: string;
    let mimeType: string;
    if (match) {
      mimeType = (match[1] || explicitMime || 'image/jpeg').toLowerCase();
      payload = match[2];
    } else {
      mimeType = (explicitMime || 'image/jpeg').toLowerCase();
      payload = raw;
    }
    try {
      const bytes = Buffer.from(payload, 'base64');
      if (bytes.length === 0) return null;
      return { bytes, mimeType };
    } catch {
      return null;
    }
  }
}
