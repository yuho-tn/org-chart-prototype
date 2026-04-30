const KEY = "org-chart-prototype:author";

export function getAuthor(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setAuthor(name: string): void {
  try {
    localStorage.setItem(KEY, name.trim());
  } catch {
    // ignore quota errors
  }
}

export function clearAuthor(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
