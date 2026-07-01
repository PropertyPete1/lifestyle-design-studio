import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { sdk } from "./_core/sdk";
import * as db from "./db";
import type { User } from "../drizzle/schema";

// This test locks in the mobile fix: when a phone sends a STALE/INVALID session
// cookie but a VALID Authorization: Bearer token, authenticateRequest must fall
// back to the Bearer token instead of rejecting outright. This is the exact
// scenario that made the dashboard "load but not work" on iOS Safari.

const OWNER_OPEN_ID = "owner-open-id";

const ownerUser: User = {
  id: 1,
  openId: OWNER_OPEN_ID,
  email: "owner@example.com",
  name: "Owner",
  loginMethod: "manus",
  role: "admin",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

function makeReq(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("authenticateRequest mobile Bearer fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Never touch the real database in these auth tests.
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(ownerUser);
    vi.spyOn(db, "upsertUser").mockResolvedValue(undefined as unknown as void);
  });

  it("authenticates via Bearer token when the cookie is invalid/stale", async () => {
    const validToken = await sdk.createSessionToken(OWNER_OPEN_ID, {
      name: "Owner",
    });

    const req = makeReq({
      cookie: `app_session_id=this-is-a-stale-invalid-cookie`,
      authorization: `Bearer ${validToken}`,
    });

    const user = await sdk.authenticateRequest(req);
    expect(user.openId).toBe(OWNER_OPEN_ID);
    expect(user.role).toBe("admin");
  });

  it("still authenticates normally when only a valid cookie is present", async () => {
    const validToken = await sdk.createSessionToken(OWNER_OPEN_ID, {
      name: "Owner",
    });

    const req = makeReq({ cookie: `app_session_id=${validToken}` });

    const user = await sdk.authenticateRequest(req);
    expect(user.openId).toBe(OWNER_OPEN_ID);
  });

  it("rejects when neither credential is valid", async () => {
    const req = makeReq({
      cookie: `app_session_id=bad`,
      authorization: `Bearer also-bad`,
    });

    await expect(sdk.authenticateRequest(req)).rejects.toBeTruthy();
  });
});
