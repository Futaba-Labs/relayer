# calculateOptimalGas() 詳細処理分析

## 概要
`calculateOptimalGas()`メソッドは、Across Relayerシステムにおいて履歴データ(`intents.json`)を活用して最適なガス価格を動的に計算する核心的な関数です。このメソッドは収益性を保証しながら競争力のあるガス価格を提供します。

## メソッドシグネチャ
```typescript
private async calculateOptimalGas(
  baseFee: bigint,      // 現在のベースフィー
  gasUsed: bigint,      // 推定ガス使用量
  relayerFee: bigint    // リレイヤーフィー
): Promise<GasCalculationResult | null>
```

## 処理フロー詳細

### 1. 初期化とバリデーション (928-941行)

```typescript
const intents: Intent[] = getIntentsFromJson();

if (intents.length === 0) {
  return null;
}

// 最小出力金額チェック (0.01 ETH未満は処理しない)
if (this.fillOrder.order.outputAmount < parseEther('0.01')) {
  logger.debug(`Output amount is too low: ${formatUnits(...)} ${outputTokenSymbol}`);
  return null;
}
```

**処理内容:**
- `intents.json`から履歴データを読み込み
- データが存在しない場合は処理中止
- 出力金額が0.01 ETH未満の小額注文は処理対象外

### 2. チェーンIDフィルタリング (943-955行)

```typescript
// ステップ1: ソースチェーンIDと宛先チェーンIDでフィルタリング
const chainFilteredIntents = intents.filter(
  (intent) =>
    intent.srcChainId === Number(this.fillOrder.order.originChainId) &&
    intent.dstChainId === Number(this.fillOrder.dstChainId)
);

if (chainFilteredIntents.length === 0) {
  logger.debug(`No intent found for srcChainId: ${...}, dstChainId: ${...}`);
  return null;
}
```

**処理内容:**
- 現在の注文のソース・宛先チェーンと一致する履歴データのみを抽出
- 該当データがない場合は処理中止

### 3. トークンシンボルフィルタリング (957-968行)

```typescript
// ステップ2: トークンシンボルでフィルタリング
const { symbol: currentOutputTokenSymbol } = this.getTokenInfo(this.fillOrder.order.outputToken);
const tokenFilteredIntents = chainFilteredIntents.filter(
  (intent) => intent.tokenSymbol === currentOutputTokenSymbol
);

if (tokenFilteredIntents.length === 0) {
  logger.debug(`No intent found for tokenSymbol: ${currentOutputTokenSymbol}`);
  return null;
}
```

**処理内容:**
- 現在の注文の出力トークンと同じシンボルの履歴データのみを抽出
- トークン固有の価格変動特性を考慮

### 4. 金額近似度ソート (970-977行)

```typescript
// ステップ3: 金額近似度でソート（絶対差分）
const targetAmount = Number(this.fillOrder.order.outputAmount);
const sortedByAmount = tokenFilteredIntents.sort((a, b) => {
  const diffA = Math.abs(a.outputAmount - targetAmount);
  const diffB = Math.abs(b.outputAmount - targetAmount);
  return diffA - diffB;
})
.slice(0, 100); // 上位100件に限定
```

**処理内容:**
- 現在の注文金額に最も近い履歴データを優先
- 絶対差分で計算し、上位100件に限定
- 金額規模による収益性の違いを考慮

### 5. ベースフィー近似度ソート (979-987行)

```typescript
// ステップ4: ベースフィー近似度でフィルタ（絶対差分）し、30件に限定
const targetBaseFee = Number(baseFee);
const sortedByBaseFee = sortedByAmount
  .sort((a, b) => {
    const diffA = Math.abs(a.baseFee - targetBaseFee);
    const diffB = Math.abs(b.baseFee - targetBaseFee);
    return diffA - diffB;
  })
  .slice(0, 30); // 最終的に30件に限定
```

**処理内容:**
- 現在のベースフィーに最も近い市場条件の履歴データを選択
- ガス価格環境の類似性を重視
- 最終的に30件の最も関連性の高いデータに絞り込み

### 6. 平均利益BPS計算 (989-999行)

```typescript
// ステップ5: 限定されたマッチングインテントから平均利益bpsを計算
const avgProfitBps =
  sortedByBaseFee.reduce((sum, intent) => sum + intent.profitBps, 0) /
  sortedByBaseFee.length;

logger.debug(`Avg profit bps: ${avgProfitBps}`);

if (avgProfitBps < 0.5) {
  logger.debug(`Avg profit bps is less than 0.5`);
  return null;
}
```

**処理内容:**
- 選択された履歴データから平均利益BPS（ベーシスポイント）を算出
- 0.5 BPS未満の場合は収益性が低いとして処理中止
- 1 BPS = 0.01%（例：100 BPS = 1%）

### 7. 注文タイプ別利益調整 (1001-1010行)

```typescript
let profitBps = avgProfitBps;
if (this.fillOrder.orderType === OrderType.EXCLUSIVE) {
  profitBps = avgProfitBps * 1; // 排他的注文は100%
} else {
  if (this.fillOrder.dstChainId === BigInt(CHAIN_IDs.MAINNET)) {
    profitBps = profitBps * 0.65; // メインネット: 65%
  } else {
    profitBps = profitBps * 0.8;  // その他L2: 80%
  }
}
```

**処理内容:**
- **排他的注文**: 履歴平均の100%を目標利益とする
- **非排他的注文（メインネット）**: 競争を考慮して65%に減額
- **非排他的注文（L2）**: 競争を考慮して80%に減額

### 8. 利益計算とバリデーション (1012-1026行)

```typescript
const profit = Math.ceil(
  (Number(this.fillOrder.order.outputAmount) * profitBps) / 10000
);

logger.debug(
  `Profit: ${formatUnits(BigInt(profit), outputTokenDecimals)} ${outputTokenSymbol}`
);

if (profit < 0) {
  logger.debug(`Profit is less than 0`);
  return null;
}
```

**処理内容:**
- 調整された利益BPSから実際の利益額を計算
- BPS計算式: `利益 = (注文金額 × 利益BPS) ÷ 10000`
- 負の利益の場合は処理中止

### 9. ガス価格計算 (1028-1043行)

```typescript
// 利益調整でガス価格を計算
// まずトークン単位での差分を計算
const relayerFeeBigInt = BigInt(relayerFee);
const profitBigInt = BigInt(profit.toString());
const difference = relayerFeeBigInt - profitBigInt;

// 必要に応じて差分をETHに変換
const gasPrice =
  (await this.convertTokenValue(
    difference,
    this.fillOrder.order.outputToken,
    'toEth'
  )) / gasUsed;
const maxPriorityFeePerGas = gasPrice - baseFee;
const maxFeePerGas = BigInt(baseFee) * BigInt(2) + maxPriorityFeePerGas;
```

**処理内容:**
- リレイヤーフィーから目標利益を差し引いて差額を計算
- 差額をETH単位に変換（必要に応じて）
- ガス価格 = 差額 ÷ ガス使用量
- EIP-1559形式のガス価格パラメータを計算

### 10. ネガティブ優先フィー処理 (1044-1060行)

```typescript
if (maxPriorityFeePerGas < 0) {
  logger.debug(`Max priority fee per gas is less than 0`);

  const priorityFee =
    BigInt(CHAIN_IDs.MAINNET) == this.fillOrder.dstChainId
      ? parseGwei('0.01')     // メインネット: 0.01 Gwei
      : parseGwei('0.0005');  // L2: 0.0005 Gwei

  return {
    gasPrice: baseFee + priorityFee,
    maxFeePerGas: baseFee * BigInt(2) + priorityFee,
    maxPriorityFeePerGas: priorityFee,
    gasUsed: gasUsed,
    baseFeePerGas: baseFee,
    relayerFee: relayerFee,
  };
}
```

**処理内容:**
- 優先フィーが負の値になる場合の安全装置
- チェーン別の最小優先フィーを設定
- 最小限のガス価格で処理を継続

### 11. 結果返却 (1075-1079行)

```typescript
return {
  gasPrice,
  maxFeePerGas,
  maxPriorityFeePerGas,
  gasUsed,
  baseFeePerGas,
  relayerFee,
};
```

## データ構造

### Intent型定義
```typescript
export type Intent = {
  outputAmount: number;    // 出力金額
  baseFee: number;        // ベースフィー
  profitBps: number;      // 利益BPS
  srcChainId: number;     // ソースチェーンID
  dstChainId: number;     // 宛先チェーンID
  tokenSymbol: string;    // トークンシンボル
};
```

## アルゴリズムの特徴

### 1. 多段階フィルタリング
- チェーンID → トークン → 金額近似度 → ベースフィー近似度の順で段階的に絞り込み
- 最終的に最も関連性の高い30件のデータから判断

### 2. 競争環境考慮
- 排他的注文は優遇レート
- 非排他的注文は競争を想定して利益率を下げる
- チェーン別の競争環境の違いを考慮

### 3. 安全装置
- 最小金額制限（0.01 ETH）
- 最小利益率制限（0.5 BPS）
- ネガティブ優先フィー時の代替処理

### 4. 動的価格調整
- 市場条件に基づくリアルタイム調整
- 履歴データからの学習機能
- トークン・チェーン固有の特性考慮

このアルゴリズムにより、Across Relayerは市場条件に応じて動的に最適なガス価格を設定し、収益性を保証しながら競争力を維持しています。