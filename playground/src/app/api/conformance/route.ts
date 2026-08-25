import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function GET() {
  try {
    const reportPath = join(process.cwd(), "..", "conformance-report.json");
    const raw = await readFile(reportPath, "utf8");
    return NextResponse.json({ available: true, report: JSON.parse(raw) });
  } catch {
    // Fallback if located in same directory or running standalone
    try {
      const altPath = join(process.cwd(), "conformance-report.json");
      const raw = await readFile(altPath, "utf8");
      return NextResponse.json({ available: true, report: JSON.parse(raw) });
    } catch {
      return NextResponse.json(
        {
          available: false,
          reason:
            "No conformance report on disk. Run `npm run conformance` at the repository root to produce one.",
        },
        { status: 404 }
      );
    }
  }
}
