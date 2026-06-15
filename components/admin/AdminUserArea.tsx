"use client";

import { UserButton } from "@clerk/nextjs";

// Renderizado apenas quando o Clerk esta configurado (decidido no layout server).
export function AdminUserArea() {
  return <UserButton />;
}
