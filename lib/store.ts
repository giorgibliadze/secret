import "server-only";
import { SantaService } from "./santa";
export function service() { return new SantaService(); }
