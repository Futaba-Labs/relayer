import { SpokePoolClient } from "../clients";
import { EnhancedSpokePoolClient } from "../clients/EnhancedSpokePoolClient";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient | EnhancedSpokePoolClient;
}
