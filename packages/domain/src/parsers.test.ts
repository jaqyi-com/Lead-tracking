import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePortalEmail } from "./parsers";

// Every portal fixture must keep parsing. When a real email breaks a parser, anonymise it, add it
// here with the expected fields, then fix the parser (§6.2).
const dir = resolve(__dirname, "../../../fixtures/portal");

describe("portal parser fixtures", () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(file, () => {
      const fx = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      const r = parsePortalEmail({ from: fx.from, subject: fx.subject, text: fx.text });
      expect(r.matched).toBe(true);
      if (fx.expectFailure) {
        expect(r.matched && !r.ok).toBe(true);
        return;
      }
      expect(r.matched && r.ok, JSON.stringify(r)).toBe(true);
      if (r.matched && r.ok) expect(r.lead).toMatchObject(fx.expect);
    });
  }
  it("ignores ordinary mail", () => {
    expect(parsePortalEmail({ from: "rahul@acme.co.in", subject: "Need data", text: "hi" }).matched).toBe(false);
  });
});
