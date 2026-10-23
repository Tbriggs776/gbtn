// Sample Floor Daddy mail for the v1 classifier. Not imported by the app.
// Check with: npx tsx lib/ops-board/ingest.fixtures.ts

import { pathToFileURL } from "node:url";
import { classifyIngestMail, splitPastedEmail, type IngestMailInput } from "./ingest";
import type { OpsBoardOwner } from "./types";

export type IngestFixture = {
  name: string;
  mail: IngestMailInput;
  expect: {
    action: "create" | "skip";
    reason?: string;
    owner?: OpsBoardOwner | null;
    ownerConfidence?: "high" | "low" | "none";
    due_on?: string | null;
    titleIncludes?: string;
    next_action?: string | null;
  };
};

export const INGEST_FIXTURES: IngestFixture[] = [
  {
    name: "promo with unsubscribe",
    mail: {
      externalKey: "promo-1",
      from: "deals@retailer.example",
      subject: "20% off carpet this weekend",
      bodyText:
        "View in browser. Huge savings on remnant rolls. You are receiving this because you shopped with us. Unsubscribe. Unsubscribe from all.",
      receivedAt: "2026-09-20",
    },
    expect: { action: "skip", reason: "newsletter or marketing", owner: null },
  },
  {
    name: "out of office",
    mail: {
      externalKey: "ooo-1",
      from: "karen@floordaddy.example",
      subject: "Automatic reply: payroll question",
      bodyText: "I am out of the office until Monday with no access to email.",
      receivedAt: "2026-09-21",
    },
    expect: { action: "skip", reason: "auto-reply" },
  },
  {
    name: "calendar hold with no ask",
    mail: {
      externalKey: "cal-1",
      from: "calendar@floordaddy.example",
      subject: "Invitation: Team standup",
      bodyText: "Karen has invited you to a meeting. No agenda is attached.",
      receivedAt: "2026-09-22",
    },
    expect: { action: "skip", reason: "calendar invite with no ask" },
  },
  {
    name: "personal lunch",
    mail: {
      externalKey: "lunch-1",
      from: "friend@gmail.com",
      subject: "Lunch Thursday?",
      bodyText: "Hey Tyler, want to grab lunch?",
      receivedAt: "2026-09-22",
    },
    expect: { action: "skip", reason: "personal, no ops ask" },
  },
  {
    name: "missed install with a job id",
    mail: {
      externalKey: "cg-184422",
      from: "scheduler@floordaddy.example",
      subject: "Missed install CG184422",
      bodyText:
        "Customer was not home for the install. Need to collect the balance and reschedule. Please have Karen update the job.",
      receivedAt: "2026-09-22",
    },
    expect: {
      action: "create",
      owner: "karen",
      ownerConfidence: "low",
      titleIncludes: "CG184422",
      next_action: "Follow up on the missed install",
    },
  },
  {
    name: "Paychex new-hire addressed to Karen",
    mail: {
      externalKey: "paychex-1",
      from: "payroll@floordaddy.example",
      subject: "Karen — Paychex T&A for new hire",
      bodyText: "Hi Karen, please approve the new-hire paperwork in Paychex. Due by 9/30/2026.",
      receivedAt: "2026-09-23",
    },
    expect: {
      action: "create",
      owner: "karen",
      ownerConfidence: "high",
      due_on: "2026-09-30",
      titleIncludes: "Paychex",
      next_action: "Complete the new-hire paperwork",
    },
  },
  {
    name: "statement approval and a refund",
    mail: {
      externalKey: "stmt-1",
      from: "books@floordaddy.example",
      subject: "Refunds list for statement approval",
      bodyText: "Past-due credits need statement approval before we send them. Please review.",
      receivedAt: "2026-09-23",
    },
    expect: {
      action: "create",
      owner: "karen",
      ownerConfidence: "low",
      next_action: "Approve the statement",
      titleIncludes: "Refunds list",
    },
  },
  {
    name: "Tyler QuickBooks ask",
    mail: {
      externalKey: "qbo-1",
      from: "office@floordaddy.example",
      subject: "QBO deposit",
      bodyText: "Tyler, can you review the QuickBooks deposit from yesterday?",
      receivedAt: "2026-09-23",
    },
    expect: {
      action: "create",
      owner: "tyler",
      ownerConfidence: "high",
      next_action: "Review the QuickBooks item",
      titleIncludes: "QBO deposit",
    },
  },
];

export function checkIngestFixtures(): string[] {
  const problems: string[] = [];
  for (const fixture of INGEST_FIXTURES) {
    const got = classifyIngestMail(fixture.mail);
    const label = fixture.name;
    if (got.action !== fixture.expect.action) {
      problems.push(`${label}: action ${got.action}, expected ${fixture.expect.action} (${got.reason ?? ""})`);
    }
    if (fixture.expect.reason !== undefined && got.reason !== fixture.expect.reason) {
      problems.push(`${label}: reason ${got.reason}, expected ${fixture.expect.reason}`);
    }
    if (fixture.expect.owner !== undefined && got.owner !== fixture.expect.owner) {
      problems.push(`${label}: owner ${got.owner}, expected ${fixture.expect.owner}`);
    }
    if (fixture.expect.ownerConfidence !== undefined && got.ownerConfidence !== fixture.expect.ownerConfidence) {
      problems.push(
        `${label}: confidence ${got.ownerConfidence}, expected ${fixture.expect.ownerConfidence} (${got.ownerRationale ?? ""})`
      );
    }
    if (fixture.expect.due_on !== undefined && got.due_on !== fixture.expect.due_on) {
      problems.push(`${label}: due ${got.due_on}, expected ${fixture.expect.due_on}`);
    }
    if (fixture.expect.titleIncludes && !got.title.includes(fixture.expect.titleIncludes)) {
      problems.push(`${label}: title ${got.title} does not include ${fixture.expect.titleIncludes}`);
    }
    if (fixture.expect.next_action !== undefined && got.next_action !== fixture.expect.next_action) {
      problems.push(`${label}: next ${got.next_action}, expected ${fixture.expect.next_action}`);
    }
    if (got.title.length > 100) problems.push(`${label}: title longer than 100`);
    if (got.action === "create" && got.status !== "inbox") problems.push(`${label}: status ${got.status}`);
  }

  const dumped = splitPastedEmail(
    [
      "From: Karen <karen@floordaddy.example>",
      "Subject: CG190011 COD",
      "Date: Tue, 22 Sep 2026 15:04:00 -0700",
      "",
      "Please confirm the COD on this job.",
    ].join("\n")
  );
  if (!dumped || !dumped.from.includes("karen@floordaddy.example") || dumped.subject !== "CG190011 COD") {
    problems.push(`split pasted email failed: ${JSON.stringify(dumped)}`);
  }
  if (!dumped?.receivedAt) problems.push("split pasted email did not read a date");
  return problems;
}

const isDirect =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  const problems = checkIngestFixtures();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ok ${INGEST_FIXTURES.length} ingest fixtures`);
}
