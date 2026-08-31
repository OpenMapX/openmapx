export interface GithubIssueSink {
  createIssue(title: string, body: string): Promise<string>;
  findOpenIssueByTitle?(title: string): Promise<string | null>;
}

export interface CreateGithubIssueSinkOptions {
  token?: string;
  repository?: string;
  fetch?: typeof fetch;
}

const PAGE_SIZE = 100;

function requireIssueUrl(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("html_url" in value) ||
    typeof value.html_url !== "string"
  ) {
    throw new Error("GitHub create issue returned an invalid response");
  }
  return value.html_url;
}

function requireIssueList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub list issues returned an invalid response");
  }
  return value;
}

function findIssueUrl(issues: readonly unknown[], title: string): string | null {
  for (const issue of issues) {
    if (
      typeof issue === "object" &&
      issue !== null &&
      "title" in issue &&
      issue.title === title &&
      "html_url" in issue &&
      typeof issue.html_url === "string"
    ) {
      return issue.html_url;
    }
  }
  return null;
}

export function createGithubIssueSink(
  options: CreateGithubIssueSinkOptions,
): GithubIssueSink | null {
  const token = options.token?.trim();
  const repository = options.repository?.trim();
  if (!token || !repository) return null;

  const request = options.fetch ?? globalThis.fetch;
  const apiBase = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  return {
    async findOpenIssueByTitle(title: string): Promise<string | null> {
      for (let page = 1; ; page++) {
        const response = await request(
          `${apiBase}/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`,
          { headers },
        );
        if (!response.ok) {
          throw new Error(`GitHub list issues failed: ${response.status} ${response.statusText}`);
        }
        const issues = requireIssueList(await response.json());
        const match = findIssueUrl(issues, title);
        if (match) return match;
        if (issues.length < PAGE_SIZE) return null;
      }
    },

    async createIssue(title: string, body: string): Promise<string> {
      const response = await request(`${apiBase}/issues`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      if (!response.ok) {
        throw new Error(`GitHub create issue failed: ${response.status} ${response.statusText}`);
      }
      return requireIssueUrl(await response.json());
    },
  };
}
