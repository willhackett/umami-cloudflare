// Kafka is not part of the Cloudflare stack; umami only instantiates it when KAFKA_URL is set.
export type KafkaMessage = { key?: string; value: string };
export type RecordMetadata = never;
export type Producer = never;
export const logLevel = { ERROR: 1 };

export class Kafka {
  constructor() {
    throw new Error('[umami-cloudflare] Kafka is not supported on Cloudflare. Unset KAFKA_URL.');
  }
}
