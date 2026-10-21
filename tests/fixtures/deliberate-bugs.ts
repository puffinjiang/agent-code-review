// Fixture 1: Soft-delete omission
export async function listActiveUsers(db: any) {
  // BUG: Missing `where: { deleted_at: null }`
  return db.user.findMany({
    select: { id: true, name: true, email: true }
  });
}

// Fixture 2: Insecure Direct Object Reference (IDOR)
export async function getDocument(req: any, db: any) {
  // BUG: Authenticated user id is req.user.id, but query fetches doc by req.params.id without checking owner
  const doc = await db.document.findUnique({
    where: { id: req.params.id }
  });
  return doc;
}

// Fixture 3: Race condition in duplicate task processing
export async function claimAndProcessTask(taskId: string, db: any) {
  // BUG: Check-then-act without transaction isolation or atomic claim
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (task.status === "PENDING") {
    // Context switch or concurrent execution here allows two workers to claim the same task
    await db.task.update({ where: { id: taskId }, data: { status: "PROCESSING" } });
    return true;
  }
  return false;
}

// Fixture 4: SQL Injection
export async function searchProducts(keyword: string, rawDb: any) {
  // BUG: Direct string concatenation into raw SQL
  return rawDb.query(`SELECT * FROM products WHERE name LIKE '%${keyword}%'`);
}

// Fixture 5: Synchronous blocking call inside async event loop
import * as fs from "node:fs";
export async function readConfiguration(filePath: string) {
  // BUG: Synchronous I/O in async request path
  return fs.readFileSync(filePath, "utf-8");
}
