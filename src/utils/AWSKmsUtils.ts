import { KMSClient, SignCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { ethers } from "ethers";
import { Logger } from "./LogUtils";

// AWS KMS key configuration interface
export interface AWSKmsKeyConfig {
  keyId: string;
  region: string;
  profile?: string;
}

/**
 * AWS KMS Signer implementation that uses KMS keys directly for signing
 * without exposing private keys in memory
 */
export class AWSKmsSigner extends ethers.Signer {
  private kmsClient: KMSClient;
  private keyId: string;
  private _address?: string;
  private _publicKey?: string;

  constructor(keyConfig: AWSKmsKeyConfig, provider?: ethers.providers.Provider) {
    super();
    this.keyId = keyConfig.keyId;
    
    // Initialize KMS client with region and optional profile
    const clientConfig: any = {
      region: keyConfig.region,
    };

    // Use AWS profile if specified
    if (keyConfig.profile) {
      const { fromProfile } = require("@aws-sdk/credential-providers");
      clientConfig.credentials = fromProfile({ profile: keyConfig.profile });
    }

    this.kmsClient = new KMSClient(clientConfig);

    if (provider) {
      this.connect(provider);
    }
  }

  /**
   * Get the Ethereum address derived from the KMS public key
   */
  async getAddress(): Promise<string> {
    if (this._address) {
      return this._address;
    }

    const publicKey = await this.getPublicKey();
    this._address = ethers.utils.computeAddress(publicKey);
    
    Logger.debug({
      at: "AWSKmsSigner#getAddress",
      message: "Derived Ethereum address from KMS public key",
      keyId: this.keyId,
      address: this._address,
    });

    return this._address;
  }

  /**
   * Get the public key from AWS KMS
   */
  async getPublicKey(): Promise<string> {
    if (this._publicKey) {
      return this._publicKey;
    }

    try {
      const command = new GetPublicKeyCommand({ KeyId: this.keyId });
      const response = await this.kmsClient.send(command);

      if (!response.PublicKey) {
        throw new Error("No public key returned from AWS KMS");
      }

      // Convert DER-encoded public key to uncompressed format
      this._publicKey = this.derToUncompressedPublicKey(response.PublicKey);
      
      Logger.debug({
        at: "AWSKmsSigner#getPublicKey",
        message: "Retrieved public key from AWS KMS",
        keyId: this.keyId,
      });

      return this._publicKey;
    } catch (error) {
      Logger.error({
        at: "AWSKmsSigner#getPublicKey",
        message: "Failed to retrieve public key from AWS KMS",
        keyId: this.keyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Sign a message using AWS KMS
   */
  async signMessage(message: ethers.utils.Bytes | string): Promise<string> {
    const messageBytes = ethers.utils.arrayify(message);
    const messageHash = ethers.utils.hashMessage(messageBytes);
    return this.signDigest(messageHash);
  }

  /**
   * Sign a transaction using AWS KMS
   */
  async signTransaction(transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>): Promise<string> {
    const tx = await ethers.utils.resolveProperties(transaction);
    
    // Remove signature fields if present
    delete tx.from;
    delete tx.v;
    delete tx.r;
    delete tx.s;

    const serialized = ethers.utils.serializeTransaction(tx);
    const hash = ethers.utils.keccak256(serialized);
    const signature = await this.signDigest(hash);

    return ethers.utils.serializeTransaction(tx, signature);
  }

  /**
   * Sign a digest (hash) using AWS KMS
   */
  private async signDigest(digest: string): Promise<string> {
    try {
      const digestBytes = ethers.utils.arrayify(digest);
      
      const command = new SignCommand({
        KeyId: this.keyId,
        Message: digestBytes,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      });

      const response = await this.kmsClient.send(command);

      if (!response.Signature) {
        throw new Error("No signature returned from AWS KMS");
      }

      // Convert DER signature to Ethereum format
      const signature = await this.derToEthereumSignature(response.Signature, digest);
      
      Logger.debug({
        at: "AWSKmsSigner#signDigest",
        message: "Successfully signed digest with AWS KMS",
        keyId: this.keyId,
        digestLength: digestBytes.length,
      });

      return signature;
    } catch (error) {
      Logger.error({
        at: "AWSKmsSigner#signDigest",
        message: "Failed to sign digest with AWS KMS",
        keyId: this.keyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Connect signer to a new provider
   */
  connect(provider: ethers.providers.Provider): AWSKmsSigner {
    const newSigner = new AWSKmsSigner(
      { keyId: this.keyId, region: this.kmsClient.config.region as string },
      provider
    );
    
    // Transfer cached values
    newSigner._address = this._address;
    newSigner._publicKey = this._publicKey;
    
    return newSigner;
  }

  /**
   * Convert DER-encoded public key to uncompressed format
   */
  private derToUncompressedPublicKey(derPublicKey: Uint8Array): string {
    // Parse DER structure to extract the 64-byte public key
    // DER format for secp256k1: 0x30 + length + 0x30 + length + OID + 0x03 + length + 0x00 + public_key
    const publicKeyBytes = derPublicKey.slice(-65); // Last 65 bytes (0x04 + 64 bytes)
    
    if (publicKeyBytes[0] !== 0x04) {
      throw new Error("Invalid public key format");
    }

    return ethers.utils.hexlify(publicKeyBytes);
  }

  /**
   * Convert DER signature to Ethereum signature format
   */
  private async derToEthereumSignature(derSignature: Uint8Array, digest: string): Promise<string> {
    // Parse DER signature to extract r and s values
    const { r, s } = this.parseDERSignature(derSignature);
    
    // Calculate recovery ID
    const recoveryId = await this.calculateRecoveryId(r, s, digest);
    
    // Ensure s is in the lower half of the curve order (canonical form)
    const canonicalS = this.ensureCanonicalS(s);
    
    return ethers.utils.joinSignature({
      r: ethers.utils.hexZeroPad(ethers.utils.hexlify(r), 32),
      s: ethers.utils.hexZeroPad(ethers.utils.hexlify(canonicalS), 32),
      v: 27 + recoveryId,
    });
  }

  /**
   * Parse DER-encoded signature to extract r and s values
   */
  private parseDERSignature(derSignature: Uint8Array): { r: Uint8Array; s: Uint8Array } {
    let offset = 0;
    
    // Check sequence tag
    if (derSignature[offset++] !== 0x30) {
      throw new Error("Invalid DER signature format");
    }
    
    // Skip sequence length
    offset++;
    
    // Parse r
    if (derSignature[offset++] !== 0x02) {
      throw new Error("Invalid DER signature format");
    }
    
    const rLength = derSignature[offset++];
    const r = derSignature.slice(offset, offset + rLength);
    offset += rLength;
    
    // Parse s
    if (derSignature[offset++] !== 0x02) {
      throw new Error("Invalid DER signature format");
    }
    
    const sLength = derSignature[offset++];
    const s = derSignature.slice(offset, offset + sLength);
    
    return { r, s };
  }

  /**
   * Calculate recovery ID for signature
   */
  private async calculateRecoveryId(r: Uint8Array, s: Uint8Array, digest: string): Promise<number> {
    const publicKey = await this.getPublicKey();
    const address = await this.getAddress();
    
    for (let recoveryId = 0; recoveryId < 4; recoveryId++) {
      try {
        const signature = ethers.utils.joinSignature({
          r: ethers.utils.hexZeroPad(ethers.utils.hexlify(r), 32),
          s: ethers.utils.hexZeroPad(ethers.utils.hexlify(s), 32),
          v: 27 + recoveryId,
        });
        
        const recoveredAddress = ethers.utils.recoverAddress(digest, signature);
        
        if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
          return recoveryId;
        }
      } catch (error) {
        // Continue trying other recovery IDs
      }
    }
    
    throw new Error("Unable to calculate recovery ID");
  }

  /**
   * Ensure s value is in canonical form (lower half of curve order)
   */
  private ensureCanonicalS(s: Uint8Array): Uint8Array {
    const curveOrder = ethers.BigNumber.from("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const sBN = ethers.BigNumber.from(s);
    const halfOrder = curveOrder.div(2);
    
    if (sBN.gt(halfOrder)) {
      return ethers.utils.arrayify(curveOrder.sub(sBN));
    }
    
    return s;
  }
}

/**
 * Create an AWS KMS signer from configuration
 */
export function createAWSKmsSigner(
  keyId: string,
  region: string = "us-east-1",
  profile?: string,
  provider?: ethers.providers.Provider
): AWSKmsSigner {
  const config: AWSKmsKeyConfig = {
    keyId,
    region,
    profile,
  };
  
  Logger.info({
    at: "AWSKmsUtils#createAWSKmsSigner",
    message: "Creating AWS KMS signer",
    keyId,
    region,
    profile: profile || "default",
  });
  
  return new AWSKmsSigner(config, provider);
}

/**
 * Validate AWS KMS configuration
 */
export function validateAWSKmsConfig(keyId?: string, region?: string): void {
  if (!keyId) {
    throw new Error("AWS_KMS_KEY_ID environment variable is required for aws-kms wallet type");
  }
  
  if (!region) {
    throw new Error("AWS_KMS_REGION environment variable is required for aws-kms wallet type");
  }
  
  // Validate key ID format (ARN or key ID)
  const arnPattern = /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/;
  const keyIdPattern = /^[a-f0-9-]+$/;
  
  if (!arnPattern.test(keyId) && !keyIdPattern.test(keyId)) {
    throw new Error("Invalid AWS KMS key ID format. Must be either ARN or key ID.");
  }
  
  Logger.debug({
    at: "AWSKmsUtils#validateAWSKmsConfig",
    message: "AWS KMS configuration validated",
    keyId,
    region,
  });
}