import {
  expect,
  ethers,
  toBNWei,
  toBN,
  bnZero,
  randomAddress,
  createSpyLogger,
  hubPoolFixture,
  deployConfigStore,
  getCurrentTime,
  BigNumber,
} from "./utils";
import { ProfitClient, ConfigStoreClient } from "../src/clients";
import { MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { Intent, OptimalGasResult } from "../src/clients/ProfitClient";
import { CHAIN_IDs } from "../src/utils";
import * as fs from "fs";
import * as path from "path";
import * as sinon from "sinon";

let hubPoolClient: MockHubPoolClient, spokePoolClient: MockSpokePoolClient, configStoreClient: ConfigStoreClient;
let profitClient: ProfitClient;
let owner: ethers.Wallet;

const chainId = 1;
const destinationChainId = 10;

describe("ProfitClient: Dynamic Gas Calculation", async function () {
  const { spyLogger } = createSpyLogger();

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Set up hub pool and config store
    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    // Mock SpokePool for MockSpokePoolClient constructor
    const mockSpokePool = {
      address: randomAddress(),
      interface: hubPool.interface, // Just use hubPool interface for simplicity
    };

    spokePoolClient = new MockSpokePoolClient(
      spyLogger, 
      mockSpokePool as any, 
      chainId, 
      0 // deployment block
    );

    profitClient = new ProfitClient(
      spyLogger,
      hubPoolClient,
      { [chainId]: spokePoolClient },
      [chainId, destinationChainId],
      owner.address,
      toBNWei("0.0001"), // 1 bps default min relayer fee
      false, // debugProfitability
      toBNWei("1"), // gasMultiplier
      toBNWei("1"), // gasMessageMultiplier
      toBNWei("0"), // gasPadding
      []
    );
  });

  afterEach(async function () {
    sinon.restore();
    // Clean up any test files
    const testIntentsPath = path.join(process.cwd(), "intents.json");
    if (fs.existsSync(testIntentsPath)) {
      fs.unlinkSync(testIntentsPath);
    }
  });

  describe("Intent History Management", function () {
    it("Should load intent history from intents.json", async function () {
      // Create test intents.json file
      const testIntents: Intent[] = [
        {
          outputAmount: 1000000000000000000, // 1 ETH
          baseFee: 12000000000, // 12 Gwei
          profitBps: 15.5,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
          timestamp: getCurrentTime() - 3600,
        },
        {
          outputAmount: 500000000000000000, // 0.5 ETH
          baseFee: 15000000000, // 15 Gwei
          profitBps: 12.3,
          srcChainId: 1,
          dstChainId: 137,
          tokenSymbol: "USDC",
          timestamp: getCurrentTime() - 1800,
        },
      ];

      const intentsPath = path.join(process.cwd(), "intents.json");
      fs.writeFileSync(intentsPath, JSON.stringify(testIntents, null, 2));

      // Call loadIntentHistory via update method
      await profitClient.update();

      // Access private property to verify loading
      const intentHistory = (profitClient as any).intentHistory;
      expect(intentHistory).to.have.length(2);
      expect(intentHistory[0].outputAmount).to.equal(1000000000000000000);
      expect(intentHistory[1].tokenSymbol).to.equal("USDC");
    });

    it("Should handle missing intents.json file gracefully", async function () {
      // Ensure no intents.json file exists
      const intentsPath = path.join(process.cwd(), "intents.json");
      if (fs.existsSync(intentsPath)) {
        fs.unlinkSync(intentsPath);
      }

      await profitClient.update();

      const intentHistory = (profitClient as any).intentHistory;
      expect(intentHistory).to.have.length(0);
    });

    it("Should handle invalid JSON in intents.json", async function () {
      const intentsPath = path.join(process.cwd(), "intents.json");
      fs.writeFileSync(intentsPath, "invalid json content");

      await profitClient.update();

      const intentHistory = (profitClient as any).intentHistory;
      expect(intentHistory).to.have.length(0);
    });

    it("Should filter out invalid intents", async function () {
      const testIntents = [
        // Valid intent
        {
          outputAmount: 1000000000000000000,
          baseFee: 12000000000,
          profitBps: 15.5,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
        // Invalid intent - missing required fields
        {
          outputAmount: 500000000000000000,
          baseFee: 15000000000,
          // Missing profitBps
          srcChainId: 1,
          dstChainId: 137,
          tokenSymbol: "USDC",
        },
        // Invalid intent - negative output amount
        {
          outputAmount: -1000000000000000000,
          baseFee: 12000000000,
          profitBps: 15.5,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
      ];

      const intentsPath = path.join(process.cwd(), "intents.json");
      fs.writeFileSync(intentsPath, JSON.stringify(testIntents, null, 2));

      await profitClient.update();

      const intentHistory = (profitClient as any).intentHistory;
      expect(intentHistory).to.have.length(1);
      expect(intentHistory[0].outputAmount).to.equal(1000000000000000000);
    });

    it("Should cache intent history for configured time", async function () {
      const testIntents: Intent[] = [
        {
          outputAmount: 1000000000000000000,
          baseFee: 12000000000,
          profitBps: 15.5,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
      ];

      const intentsPath = path.join(process.cwd(), "intents.json");
      fs.writeFileSync(intentsPath, JSON.stringify(testIntents, null, 2));

      // Load initially
      await profitClient.update();
      const intentHistory1 = (profitClient as any).intentHistory;

      // Modify file
      testIntents.push({
        outputAmount: 2000000000000000000,
        baseFee: 20000000000,
        profitBps: 25.0,
        srcChainId: 1,
        dstChainId: 10,
        tokenSymbol: "ETH",
      });
      fs.writeFileSync(intentsPath, JSON.stringify(testIntents, null, 2));

      // Load again immediately (should be cached)
      await profitClient.update();
      const intentHistory2 = (profitClient as any).intentHistory;

      expect(intentHistory2).to.have.length(1); // Still cached, not reloaded
    });
  });

  describe("Multi-Stage Filtering Algorithm", function () {
    let testIntents: Intent[];

    beforeEach(function () {
      testIntents = [
        // Chain 1 -> 10, ETH
        {
          outputAmount: 1000000000000000000, // 1 ETH
          baseFee: 12000000000,
          profitBps: 15.5,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
        {
          outputAmount: 2000000000000000000, // 2 ETH
          baseFee: 15000000000,
          profitBps: 12.3,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
        // Chain 1 -> 137, USDC
        {
          outputAmount: 1000000000, // 1000 USDC (6 decimals)
          baseFee: 18000000000,
          profitBps: 8.7,
          srcChainId: 1,
          dstChainId: 137,
          tokenSymbol: "USDC",
        },
        // Chain 42161 -> 10, ETH
        {
          outputAmount: 1500000000000000000, // 1.5 ETH
          baseFee: 10000000000,
          profitBps: 20.1,
          srcChainId: 42161,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
      ];

      // Set up intent history in client
      (profitClient as any).intentHistory = testIntents;
    });

    it("Should filter by chain IDs correctly", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusivityDeadline: 0,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      // Mock getTokenSymbol to return ETH
      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");

      const baseFee = toBN("12000000000");
      const filteredIntents = await (profitClient as any).filterRelevantIntents(deposit, baseFee);

      // Should only include intents with srcChainId=1 and dstChainId=10
      expect(filteredIntents).to.have.length(2);
      expect(filteredIntents.every((intent) => intent.srcChainId === 1 && intent.dstChainId === 10)).to.be.true;
    });

    it("Should filter by token symbol correctly", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusivityDeadline: 0,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      // Mock getTokenSymbol to return USDC
      sinon.stub(profitClient as any, "getTokenSymbol").returns("USDC");

      const baseFee = toBN("18000000000");
      const filteredIntents = await (profitClient as any).filterRelevantIntents(deposit, baseFee);

      // Should return empty array since no ETH intents for chain 1->10
      expect(filteredIntents).to.have.length(0);
    });

    it("Should sort by amount proximity and take top results", async function () {
      // Add more intents with varying amounts
      const extendedIntents = [
        ...testIntents,
        ...Array.from({ length: 150 }, (_, i) => ({
          outputAmount: (i + 1) * 100000000000000000, // Varying amounts
          baseFee: 12000000000,
          profitBps: 15,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        })),
      ];

      (profitClient as any).intentHistory = extendedIntents;

      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"), // Target 1 ETH
        outputToken: randomAddress(),
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusivityDeadline: 0,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");

      const baseFee = toBN("12000000000");
      const filteredIntents = await (profitClient as any).filterRelevantIntents(deposit, baseFee);

      // Should take top 30 (after amount sorting to 100, then base fee sorting to 30)
      expect(filteredIntents).to.have.length(30);

      // The closest amounts should be first
      expect(filteredIntents[0].outputAmount).to.be.closeTo(1000000000000000000, 500000000000000000);
    });
  });

  describe("Dynamic Profit BPS Calculation", function () {
    let testIntents: Intent[];

    beforeEach(function () {
      testIntents = [
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 20, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 15, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 25, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
      ];
    });

    it("Should calculate average profit BPS correctly", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        exclusivityDeadline: 0, // Not exclusive
      };

      const profitBps = await (profitClient as any).calculateDynamicProfitBps(testIntents, deposit, false);

      // Average should be (20 + 15 + 25) / 3 = 20, adjusted for non-exclusive L2 (80%) = 16
      expect(profitBps).to.equal(16);
    });

    it("Should apply 100% for exclusive orders", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        exclusivityDeadline: getCurrentTime() + 3600, // Exclusive
      };

      const profitBps = await (profitClient as any).calculateDynamicProfitBps(testIntents, deposit, true);

      // Average should be (20 + 15 + 25) / 3 = 20, no adjustment for exclusive = 20
      expect(profitBps).to.equal(20);
    });

    it("Should apply 65% for non-exclusive mainnet orders", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 1, // Mainnet
        exclusivityDeadline: 0, // Not exclusive
      };

      const profitBps = await (profitClient as any).calculateDynamicProfitBps(testIntents, deposit, false);

      // Average should be (20 + 15 + 25) / 3 = 20, adjusted for mainnet (65%) = 13
      expect(profitBps).to.equal(13);
    });

    it("Should apply minimum 0.5 BPS floor", async function () {
      const lowProfitIntents = [
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 0.1, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 0.2, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
      ];

      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        exclusivityDeadline: 0,
      };

      const profitBps = await (profitClient as any).calculateDynamicProfitBps(lowProfitIntents, deposit, false);

      // Average would be 0.15, adjusted for L2 (80%) = 0.12, but minimum is 0.5
      expect(profitBps).to.equal(0.5);
    });
  });

  describe("Optimal Gas Calculation", function () {
    beforeEach(async function () {
      // Mock price client methods
      sinon.stub(profitClient, "getPriceOfToken").callsFake((symbol) => {
        if (symbol === "ETH") return toBNWei("2000"); // $2000 per ETH
        if (symbol === "USDC") return toBNWei("1"); // $1 per USDC
        return toBNWei("1");
      });

      // Set up intent history
      const testIntents: Intent[] = [
        {
          outputAmount: 1000000000000000000, // 1 ETH
          baseFee: 12000000000,
          profitBps: 15,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
      ];
      (profitClient as any).intentHistory = testIntents;
    });

    it("Should calculate optimal gas parameters correctly", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"), // 1 ETH
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      // Mock filtering and token methods
      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");
      sinon.stub(profitClient as any, "filterRelevantIntents").returns([
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 15, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
      ]);

      const baseFee = toBNWei("12", 9); // 12 Gwei
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.01"); // 0.01 ETH relayer fee

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.not.be.null;
      expect(result!.isOptimal).to.be.true;
      expect(result!.profitBps).to.equal(12); // 15 * 0.8 for L2 non-exclusive
      expect(result!.baseFeePerGas).to.equal(baseFee);
      expect(result!.gasUsed).to.equal(gasUsed);
    });

    it("Should return null for deposits below minimum output amount", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("0.005"), // Below 0.01 ETH minimum
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      const baseFee = toBNWei("12", 9);
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.01");

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.be.null;
    });

    it("Should return null when no relevant intents found", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      // Mock no relevant intents
      sinon.stub(profitClient as any, "filterRelevantIntents").returns([]);

      const baseFee = toBNWei("12", 9);
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.01");

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.be.null;
    });

    it("Should handle negative priority fee with minimum values", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 1, // Mainnet
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");
      sinon.stub(profitClient as any, "filterRelevantIntents").returns([
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 15, srcChainId: 1, dstChainId: 1, tokenSymbol: "ETH" },
      ]);

      const baseFee = toBNWei("50", 9); // High base fee
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.001"); // Low relayer fee

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.not.be.null;
      expect(result!.isOptimal).to.be.false;
      expect(result!.maxPriorityFeePerGas).to.equal(toBNWei("0.01", 9)); // Mainnet minimum 0.01 Gwei
    });
  });

  describe("Integration with Existing Profitability Calculation", function () {
    beforeEach(async function () {
      // Set up comprehensive mocks
      sinon.stub(profitClient, "getPriceOfToken").callsFake((symbol) => {
        if (symbol === "ETH") return toBNWei("2000");
        if (symbol === "USDC") return toBNWei("1");
        return toBNWei("1");
      });

      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");
      
      // Mock hubPoolClient methods
      sinon.stub(hubPoolClient, "getTokenInfoForAddress").returns({
        symbol: "ETH",
        decimals: 18,
        address: randomAddress(),
      });

      // Set up intent history
      const testIntents: Intent[] = [
        {
          outputAmount: 1000000000000000000,
          baseFee: 12000000000,
          profitBps: 20,
          srcChainId: 1,
          dstChainId: 10,
          tokenSymbol: "ETH",
        },
      ];
      (profitClient as any).intentHistory = testIntents;
    });

    it("Should use optimal gas in enhanced profitability calculation", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1.05"), // 5% fee
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
        updatedOutputAmount: undefined,
      };

      // Mock existing profitability calculation to be profitable
      sinon.stub(profitClient, "getFillProfitability").resolves({
        profitable: true,
        gasPrice: toBNWei("15", 9), // 15 Gwei
        nativeGasCost: toBN("21000"),
        grossRelayerFeeUsd: toBNWei("100"), // $100 fee
        tokenGasCost: toBNWei("0.000315"), // 21000 * 15 Gwei
        inputTokenPriceUsd: toBNWei("2000"),
        inputAmountUsd: toBNWei("2100"),
        outputTokenPriceUsd: toBNWei("2000"),
        outputAmountUsd: toBNWei("2000"),
        totalFeePct: toBNWei("0.05"),
        grossRelayerFeePct: toBNWei("0.048"),
        gasTokenPriceUsd: toBNWei("2000"),
        gasCostUsd: toBNWei("0.63"),
        netRelayerFeePct: toBNWei("0.047"),
        netRelayerFeeUsd: toBNWei("99.37"),
        gasPadding: toBNWei("1"),
        gasMultiplier: toBNWei("1"),
      });

      const lpFeePct = toBNWei("0.001");
      const l1Token = randomAddress();
      const repaymentChainId = 10;

      const result = await profitClient.getFillProfitabilityWithOptimalGas(
        deposit,
        lpFeePct,
        l1Token,
        repaymentChainId,
        true // useOptimalGas
      );

      expect(result.profitable).to.be.true;
      expect(result.optimalGas).to.not.be.undefined;
      
      if (result.optimalGas) {
        expect(result.optimalGas.isOptimal).to.be.true;
        expect(result.optimalGas.profitBps).to.equal(16); // 20 * 0.8 for L2 non-exclusive
      }
    });

    it("Should fall back to standard calculation when optimal gas fails", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("0.005"), // Below minimum
        outputToken: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1.05"),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
        updatedOutputAmount: undefined,
      };

      const standardResult = {
        profitable: true,
        gasPrice: toBNWei("15", 9),
        nativeGasCost: toBN("21000"),
        grossRelayerFeeUsd: toBNWei("100"),
        tokenGasCost: toBNWei("0.000315"),
        inputTokenPriceUsd: toBNWei("2000"),
        inputAmountUsd: toBNWei("2100"),
        outputTokenPriceUsd: toBNWei("2000"),
        outputAmountUsd: toBNWei("2000"),
        totalFeePct: toBNWei("0.05"),
        grossRelayerFeePct: toBNWei("0.048"),
        gasTokenPriceUsd: toBNWei("2000"),
        gasCostUsd: toBNWei("0.63"),
        netRelayerFeePct: toBNWei("0.047"),
        netRelayerFeeUsd: toBNWei("99.37"),
        gasPadding: toBNWei("1"),
        gasMultiplier: toBNWei("1"),
      };

      sinon.stub(profitClient, "getFillProfitability").resolves(standardResult);

      const lpFeePct = toBNWei("0.001");
      const l1Token = randomAddress();
      const repaymentChainId = 10;

      const result = await profitClient.getFillProfitabilityWithOptimalGas(
        deposit,
        lpFeePct,
        l1Token,
        repaymentChainId,
        true
      );

      expect(result.profitable).to.be.true;
      expect(result.optimalGas).to.be.undefined; // Should fallback
      expect(result.gasPrice).to.equal(standardResult.gasPrice);
    });

    it("Should skip optimal gas when useOptimalGas is false", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1.05"),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
        updatedOutputAmount: undefined,
      };

      const standardResult = {
        profitable: true,
        gasPrice: toBNWei("15", 9),
        nativeGasCost: toBN("21000"),
        grossRelayerFeeUsd: toBNWei("100"),
        tokenGasCost: toBNWei("0.000315"),
        inputTokenPriceUsd: toBNWei("2000"),
        inputAmountUsd: toBNWei("2100"),
        outputTokenPriceUsd: toBNWei("2000"),
        outputAmountUsd: toBNWei("2000"),
        totalFeePct: toBNWei("0.05"),
        grossRelayerFeePct: toBNWei("0.048"),
        gasTokenPriceUsd: toBNWei("2000"),
        gasCostUsd: toBNWei("0.63"),
        netRelayerFeePct: toBNWei("0.047"),
        netRelayerFeeUsd: toBNWei("99.37"),
        gasPadding: toBNWei("1"),
        gasMultiplier: toBNWei("1"),
      };

      sinon.stub(profitClient, "getFillProfitability").resolves(standardResult);

      const lpFeePct = toBNWei("0.001");
      const l1Token = randomAddress();
      const repaymentChainId = 10;

      const result = await profitClient.getFillProfitabilityWithOptimalGas(
        deposit,
        lpFeePct,
        l1Token,
        repaymentChainId,
        false // useOptimalGas = false
      );

      expect(result.profitable).to.be.true;
      expect(result.optimalGas).to.be.undefined;
      expect(result).to.deep.equal(standardResult);
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("Should handle conversion to ETH failures gracefully", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      // Mock price returning zero to trigger conversion failure
      sinon.stub(profitClient, "getPriceOfToken").returns(bnZero);
      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");
      sinon.stub(profitClient as any, "filterRelevantIntents").returns([
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 15, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" },
      ]);

      const baseFee = toBNWei("12", 9);
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.01");

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.be.null;
    });

    it("Should handle insufficient relayer fee to cover target profit", async function () {
      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      sinon.stub(profitClient, "getPriceOfToken").returns(toBNWei("2000"));
      sinon.stub(profitClient as any, "getTokenSymbol").returns("ETH");
      sinon.stub(profitClient as any, "filterRelevantIntents").returns([
        { outputAmount: 1000000000000000000, baseFee: 12000000000, profitBps: 50, srcChainId: 1, dstChainId: 10, tokenSymbol: "ETH" }, // High profit target
      ]);

      const baseFee = toBNWei("12", 9);
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.001"); // Very low relayer fee

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.be.null;
    });

    it("Should handle empty intent history gracefully", async function () {
      // Clear intent history
      (profitClient as any).intentHistory = [];

      const deposit = {
        originChainId: 1,
        destinationChainId: 10,
        outputAmount: toBNWei("1"),
        outputToken: randomAddress(),
        exclusivityDeadline: 0,
        depositId: toBN(1),
        depositor: randomAddress(),
        recipient: randomAddress(),
        inputToken: randomAddress(),
        inputAmount: toBNWei("1"),
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 3600,
        exclusiveRelayer: randomAddress(),
        message: "0x",
        fromLiteChain: false,
        toLiteChain: false,
      };

      const baseFee = toBNWei("12", 9);
      const gasUsed = toBN("21000");
      const relayerFee = toBNWei("0.01");

      const result = await profitClient.calculateOptimalGas(deposit, baseFee, gasUsed, relayerFee);

      expect(result).to.be.null;
    });
  });
});