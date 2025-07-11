import { KmsEthersSigner } from "aws-kms-ethers-signer";
import { ethers } from "ethers";
import { Logger } from "../utils";

// AWS KMS key configuration interface
export interface AWSKmsKeyConfig {
  keyId: string;
  region?: string;
  profile?: string;
}

/**
 * Create an AWS KMS signer using aws-kms-ethers-signer
 */
export function getAWSKmsSigner(
  keyId: string,
  region = "us-east-1",
  profile?: string,
  provider?: ethers.providers.Provider
): KmsEthersSigner {
  validateAWSKmsConfig(keyId, region);

  const kmsClientConfig: any = {
    region,
  };

  Logger.info({
    at: "AWSKmsUtils#getAWSKmsSigner",
    message: "Creating AWS KMS signer",
    keyId,
    region,
    profile: profile || "default",
  });

  const signer = new KmsEthersSigner({
    keyId,
  });

  return signer;
}

/**
 * Create an AWS KMS signer from configuration (alias for getAWSKmsSigner)
 */
export function createAWSKmsSigner(
  keyId: string,
  region = "us-east-1",
  profile?: string,
  provider?: ethers.providers.Provider
): KmsEthersSigner {
  return getAWSKmsSigner(keyId, region, profile, provider);
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
