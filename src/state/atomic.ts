import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";

/**
 * Atomic, validated JSON persistence.
 *
 * Rules learned the hard way in the PowerShell predecessor (a single literal
 * `\q` in a state file crash-looped the daemon for 19 hours):
 *  - validate the OBJECT before anything touches the disk;
 *  - write to a temp file, then rename over the target (atomic on one volume);
 *  - keep the previous version as `<file>.bak` and recover from it on read;
 *  - never let a partially written or corrupt file take the system down.
 */

function tmpName(file: string): string {
  return `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupStaleTmp(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(`${base}.tmp-`)) {
      try {
        rmSync(path.join(dir, entry), { force: true });
      } catch {
        // best effort — a locked stray tmp file must not block the write
      }
    }
  }
}

export function writeJsonAtomic<T>(file: string, value: T, schema: ZodType<T>): void {
  const validated = schema.parse(value);
  mkdirSync(path.dirname(file), { recursive: true });
  cleanupStaleTmp(file);
  const tmp = tmpName(file);
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak`);
  }
  renameSync(tmp, file);
}

export interface ReadResult<T> {
  value: T;
  /** true when the main file was unreadable and the .bak copy saved the day */
  recovered: boolean;
}

function tryParse<T>(file: string, schema: ZodType<T>): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    // Tolerate a UTF-8 BOM: the predecessor's files carried one.
    return schema.parse(JSON.parse(raw.replace(/^﻿/, "")));
  } catch {
    return undefined;
  }
}

/**
 * Read + validate. Falls back to `<file>.bak`, then to `fallback` when given.
 * Throws only when every option is exhausted.
 */
export function readJsonWithRecovery<T>(
  file: string,
  schema: ZodType<T>,
  fallback?: T,
): ReadResult<T> {
  const main = tryParse(file, schema);
  if (main !== undefined) return { value: main, recovered: false };

  const bak = tryParse(`${file}.bak`, schema);
  if (bak !== undefined) return { value: bak, recovered: true };

  if (fallback !== undefined) {
    return { value: schema.parse(fallback), recovered: existsSync(file) };
  }
  throw new Error(`Unreadable or invalid JSON (no usable backup): ${file}`);
}

/** Convenience for callers that only need the value. */
export function readJson<T>(file: string, schema: ZodType<T>, fallback?: T): T {
  return readJsonWithRecovery(file, schema, fallback).value;
}
