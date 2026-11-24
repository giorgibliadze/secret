import { service } from "@/lib/store";
import { handle } from "@/lib/http";
export function GET(request: Request) { return handle(request, service); }
export function POST(request: Request) { return handle(request, service); }
