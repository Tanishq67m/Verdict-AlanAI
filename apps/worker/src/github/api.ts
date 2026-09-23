/** Minimal GitHub REST client: just the three calls the PR comment needs. */
export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly apiUrl = "https://api.github.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    return (await res.json()) as T;
  }

  async findComment(issue: number, marker: string): Promise<{ id: number; body: string } | null> {
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<Array<{ id: number; body?: string; user?: { type?: string } }>>("GET", `/repos/${this.repo}/issues/${issue}/comments?per_page=100&page=${page}`);
      // Only bot-authored comments count: otherwise anyone could post a fake "previous run"
      // with the marker and get failing criteria carried over as passes.
      const hit = batch.find((c) => c.user?.type === "Bot" && (c.body ?? "").includes(marker));
      if (hit) return { id: hit.id, body: hit.body ?? "" };
      if (batch.length < 100) return null;
    }
    return null;
  }

  async upsertComment(issue: number, marker: string, body: string): Promise<"created" | "updated"> {
    const existing = await this.findComment(issue, marker);
    if (existing) {
      await this.request("PATCH", `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    await this.request("POST", `/repos/${this.repo}/issues/${issue}/comments`, { body });
    return "created";
  }
}
