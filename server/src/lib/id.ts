import { ObjectId } from 'bson';

/**
 * Generate a new primary-key id as an ObjectId hex string (24 lowercase
 * hex chars). The format is part of the API contract, so ids round-trip
 * unchanged through the API and client.
 */
export function newId(): string {
  return new ObjectId().toHexString();
}
