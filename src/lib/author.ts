import { STORAGE_KEYS, readStorage, writeStorage } from "./storageKeys";

export function getAuthor(): string | null {
  const v = readStorage(STORAGE_KEYS.author);
  return v && v.trim() ? v : null;
}

export function setAuthor(name: string): void {
  writeStorage(STORAGE_KEYS.author, name.trim());
}

export function clearAuthor(): void {
  writeStorage(STORAGE_KEYS.author, null);
}
