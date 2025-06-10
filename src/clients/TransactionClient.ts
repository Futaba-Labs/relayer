/* eslint-disable @typescript-eslint/no-explicit-any */
import { utils as sdkUtils, typeguards } from "@across-protocol/sdk";
import {
  winston,
  getNetworkName,
  Contract,
  runTransaction,
  BigNumber,
  blockExplorerLink,
  toBNWei,
  TransactionResponse,
  TransactionSimulationResult,
  willSucceed,
  stringifyThrownValue,
  CHAIN_IDs,
  ethers,
} from "../utils";

export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any[];
  gasLimit?: BigNumber;
  gasLimitMultiplier?: number;
  message?: string;
  mrkdwn?: string;
  value?: BigNumber;
  unpermissioned?: boolean; // If false, the transaction must be sent from the enqueuer of the method.
  // If true, then can be sent from the MakerDAO multisender contract.
  canFailInSimulation?: boolean;
  // Optional batch ID to use to group transactions
  groupId?: string;
  // If true, the transaction is being sent to a non Multicall contract so we can't batch it together
  // with other transactions.
  nonMulticall?: boolean;
}

const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { isError } = typeguards;

const DEFAULT_GASLIMIT_MULTIPLIER = 1.0;

export class TransactionClient {
  readonly nonces: { [chainId: number]: number } = {};
  private mainnetTxProvider: ethers.providers.JsonRpcProvider | null = null;

  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger) {}

  private async getMainnetTxProvider(): Promise<ethers.providers.JsonRpcProvider | null> {
    if (this.mainnetTxProvider) {
      return this.mainnetTxProvider;
    }

    const mainnetTxUrl = process.env.RPC_PROVIDER_PRIVATE_1;
    if (mainnetTxUrl) {
      this.logger.debug({
        at: "TransactionClient#getMainnetTxProvider",
        message: "Creating dedicated mainnet transaction provider",
        url: mainnetTxUrl.substring(0, 50) + "...", // Log partial URL for privacy
      });
      this.mainnetTxProvider = new ethers.providers.JsonRpcProvider(mainnetTxUrl);
      return this.mainnetTxProvider;
    }

    return null;
  }

  protected _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return willSucceed(txn);
  }

  // Each transaction is simulated in isolation; but on-chain execution may produce different
  // results due to execution sequence or intermediate changes in on-chain state.
  simulate(txns: AugmentedTransaction[]): Promise<TransactionSimulationResult[]> {
    return Promise.all(txns.map((txn: AugmentedTransaction) => this._simulate(txn)));
  }

  protected async _submit(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value, gasLimit, chainId } = txn;

    // For mainnet transactions, use a separate RPC endpoint if configured
    if (chainId === CHAIN_IDs.MAINNET) {
      const mainnetTxProvider = await this.getMainnetTxProvider();
      if (mainnetTxProvider) {
        this.logger.debug({
          at: "TransactionClient#_submit",
          message: "Using dedicated mainnet RPC endpoint for transaction submission",
          chainId,
          method,
        });

        // Connect the signer to the mainnet transaction provider
        const mainnetSigner = contract.signer.connect(mainnetTxProvider);
        // Create a new contract instance with the mainnet transaction provider
        const mainnetContract = new Contract(contract.address, contract.interface, mainnetSigner);
        try {
          return await runTransaction(this.logger, mainnetContract, method, args, value, gasLimit, nonce);
        } catch (error) {
          this.logger.warn({
            at: "TransactionClient#_submit",
            message: "Failed to submit transaction via mainnet TX RPC, falling back to standard provider",
            error: stringifyThrownValue(error),
          });
          // Fall back to original provider
          return runTransaction(this.logger, contract, method, args, value, gasLimit, nonce);
        }
      }
    }

    // Default behavior for non-mainnet chains or when no separate mainnet RPC is configured
    return runTransaction(this.logger, contract, method, args, value, gasLimit, nonce);
  }

  async submit(chainId: number, txns: AugmentedTransaction[]): Promise<TransactionResponse[]> {
    const networkName = getNetworkName(chainId);
    const txnResponses: TransactionResponse[] = [];

    this.logger.debug({
      at: "TransactionClient#submit",
      message: `Processing ${txns.length} transactions.`,
    });

    // Transactions are submitted sequentially to avoid nonce collisions. More
    // advanced nonce management may permit them to be submitted in parallel.
    let mrkdwn = "";
    for (let idx = 0; idx < txns.length; ++idx) {
      const txn = txns[idx];

      if (txn.chainId !== chainId) {
        throw new Error(`chainId mismatch for method ${txn.method} (${txn.chainId} !== ${chainId})`);
      }

      const nonce = this.nonces[chainId] ? this.nonces[chainId] + 1 : undefined;

      // @dev It's assumed that nobody ever wants to discount the gasLimit.
      const gasLimitMultiplier = txn.gasLimitMultiplier ?? DEFAULT_GASLIMIT_MULTIPLIER;
      if (gasLimitMultiplier > DEFAULT_GASLIMIT_MULTIPLIER) {
        this.logger.debug({
          at: "TransactionClient#_submit",
          message: `Padding gasLimit estimate on ${txn.method} transaction.`,
          estimate: txn.gasLimit,
          gasLimitMultiplier,
        });
        txn.gasLimit = txn.gasLimit?.mul(toBNWei(gasLimitMultiplier)).div(fixedPoint);
      }

      let response: TransactionResponse;
      try {
        response = await this._submit(txn, nonce);
      } catch (error) {
        delete this.nonces[chainId];
        this.logger.info({
          at: "TransactionClient#submit",
          message: `Transaction ${idx + 1} submission on ${networkName} failed or timed out.`,
          mrkdwn,
          // @dev `error` _sometimes_ doesn't decode correctly (especially on Polygon), so fish for the reason.
          errorMessage: isError(error) ? (error as Error).message : undefined,
          error: stringifyThrownValue(error),
          notificationPath: "across-error",
        });
        return txnResponses;
      }

      this.nonces[chainId] = response.nonce;
      const blockExplorer = blockExplorerLink(response.hash, txn.chainId);
      mrkdwn += `  ${idx + 1}. ${txn.message || "No message"} (${blockExplorer}): ${txn.mrkdwn || "No markdown"}\n`;
      txnResponses.push(response);
    }

    this.logger.info({
      at: "TransactionClient#submit",
      message: `Completed ${networkName} transaction submission! 🧙`,
      mrkdwn,
    });

    return txnResponses;
  }
}
