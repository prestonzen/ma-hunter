export * from "../../shared/types";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  MOCK?: string;
  PUBLIC_DASHBOARD?: string;
  ADMIN_TOKEN?: string;
  AGENT_TOKENS?: string;
  GMAIL_BRIDGE_TOKEN?: string;
  FLIPPA_TOKEN?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
