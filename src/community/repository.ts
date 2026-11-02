import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GamePack, maxPackageBytes, packSummary, validateGamePack } from './package';
export interface PackRecord { id: string; publishedAt: string; pack: GamePack }
export interface PackRepository {
  list(): Promise<(ReturnType<typeof packSummary> & { id: string; publishedAt: string })[]>;
  get(id: string): Promise<PackRecord | null>;
  publish(pack: GamePack): Promise<PackRecord>;
  remove(id: string): Promise<void>;
}
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
const packId = (pack: GamePack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');
export class FilePackRepository implements PackRepository {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true }); }
  private path(id: string) { if (!validId(id)) throw new Error('Invalid pack ID.'); return join(this.directory, `${id}.json`); }
  async get(id: string): Promise<PackRecord | null> {
    const path = this.path(id); if (!existsSync(path)) return null;
    if (statSync(path).size > maxPackageBytes + 1000) throw new Error('Stored game pack is too large.');
    const bytes = readFileSync(path); if (bytes.length > maxPackageBytes + 1000) throw new Error('Stored game pack is too large.');
    const stored = JSON.parse(bytes.toString('utf8')), pack = validateGamePack(stored.pack);
    if (stored.id !== id || packId(pack) !== id || typeof stored.publishedAt !== 'string' || !Number.isFinite(Date.parse(stored.publishedAt))) throw new Error('Stored game pack failed validation.');
    return { id, publishedAt: stored.publishedAt, pack };
  }
  async list() {
    const rows = [];
    for (const filename of readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const row = await this.get(filename.slice(0, -5)); if (row) rows.push({ id: row.id, publishedAt: row.publishedAt, ...packSummary(row.pack) });
    }
    return rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  }
  async publish(value: GamePack) {
    const pack = validateGamePack(value), id = packId(pack), path = this.path(id);
    const existing = await this.get(id); if (existing) return existing;
    if (readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 200) throw new Error('This local library supports up to 200 packs.');
    const row = { id, publishedAt: new Date().toISOString(), pack };
    writeFileSync(`${path}.tmp`, JSON.stringify(row), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    return row;
  }
  async remove(id: string) { const path = this.path(id); if (existsSync(path)) unlinkSync(path); }
}
