import { web3 } from "@coral-xyz/anchor";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { isSignerWallet, Signer } from "./";
import assert from "assert";

export function getSvmSignerFromEvmSigner(evmSigner: Signer): web3.Keypair {
  if (!isSignerWallet(evmSigner)) {
    // For non-wallet signers (like AWS KMS), return a dummy keypair
    // This keypair should not be used for actual signing operations
    return createDummySvmSigner();
  }

  // Extract the private key from the evm signer and use it to create a svm signer.
  const evmPrivateKey = evmSigner._signingKey().privateKey;
  return getSvmSignerFromPrivateKey(evmPrivateKey);
}

export function getSvmSignerFromPrivateKey(privateKey: string): web3.Keypair {
  const privateKeyAsBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), "hex"));
  return web3.Keypair.fromSeed(privateKeyAsBytes);
}

export async function getKitKeypairFromEvmSigner(evmSigner: Signer): Promise<KeyPairSigner> {
  if (!isSignerWallet(evmSigner)) {
    // For non-wallet signers (like AWS KMS), return a dummy keypair
    const dummySigner = createDummySvmSigner();
    return createKeyPairSignerFromBytes(dummySigner.secretKey);
  }

  const web3Signer = getSvmSignerFromEvmSigner(evmSigner);
  return createKeyPairSignerFromBytes(web3Signer.secretKey);
}

/**
 * Create a dummy SVM signer for non-wallet signers (like AWS KMS)
 * This should only be used for address generation and not for actual signing
 */
function createDummySvmSigner(): web3.Keypair {
  // Create a deterministic dummy keypair using a fixed seed
  // This ensures consistent behavior across restarts
  const dummySeed = new Uint8Array(32);
  dummySeed.fill(1); // Fill with 1s to create a deterministic seed
  return web3.Keypair.fromSeed(dummySeed);
}
