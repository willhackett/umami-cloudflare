import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// umami renders everything dynamically, so no incremental cache / queue is needed.
export default defineCloudflareConfig({});
