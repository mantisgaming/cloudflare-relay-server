import { DurableObject } from "cloudflare:workers";
import { Bucket } from "./Bucket";

type BucketParamMap = [string, Bucket.BucketParameters][];

// Durable Object for generating unique lobby codes
export class IPRateLimiterDO extends DurableObject<Env> {
    private readonly bucketParamMap: BucketParamMap;
    private readonly defaultBucketParams: Bucket.BucketParameters = {
        capacity: 20,
        fillRate: 60
    };

    private lastClean: number = Date.now();

    // constructor
    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.bucketParamMap = [
            ["any", {
                capacity: env.RATE_LIMITER_IP_ANY_CAPACITY,
                fillRate: env.RATE_LIMITER_IP_ANY_RATE
            }],
            ["create", {
                capacity: env.RATE_LIMITER_IP_CREATE_CAPACITY,
                fillRate: env.RATE_LIMITER_IP_CREATE_RATE
            }],
            ["reconnect", {
                capacity: env.RATE_LIMITER_IP_RECONNECT_CAPACITY,
                fillRate: env.RATE_LIMITER_IP_RECONNECT_RATE
            }],
            ["join", {
                capacity: env.RATE_LIMITER_IP_JOIN_CAPACITY,
                fillRate: env.RATE_LIMITER_IP_JOIN_RATE
            }],
        ];

        ctx.blockConcurrencyWhile(async () => {
            this.lastClean = await ctx.storage.get<number>("lastClean") ?? Date.now();
            await this.clean(true);
        })
    }

    /** Acquire permission to make a request */
    public async acquireToken(IPAddress: string, requestType: string): Promise<boolean> {
        const bucket = await this.getBucket([IPAddress, requestType]);
        const result = Bucket.acquireToken(bucket);
        await this.saveBucket([IPAddress, requestType], bucket.state);

        await this.clean();

        return result;
    }

    private async getBucket(key: [string, string]): Promise<Bucket.BucketData> {
        const bucketID = `${key[0]}:${key[1]}`;

        // Check for an existing bucket
        const result = await this.env.RELAY_D1.prepare(`
            SELECT * FROM buckets WHERE bucketid = ?;    
        `).bind(bucketID).first();

        // Try to return the existing bucket
        try {
            if (result !== null) {
                const state = JSON.parse(result.bucketstate as string);

                return {
                    params: this.getParamsForRequest(key[1]),
                    state: state
                };
            }
        } catch { }

        // send a new bucket
        const params = this.getParamsForRequest(key[1]);
        const newBucket: Bucket.BucketData = {
            params,
            state: Bucket.createDefaultState(params)
        }

        return newBucket;
    }

    private async saveBucket(key: [string, string], state: Bucket.BucketState): Promise<void> {
        const bucketID = `${key[0]}:${key[1]}`;

        const result = await this.env.RELAY_D1.prepare(`
            REPLACE INTO buckets (bucketid, bucketstate) VALUES (?, ?);
        `).bind(bucketID, JSON.stringify(state)).run();

        if (!result.success) {
            console.log(result.error);
        }
    }

    private getParamsForRequest(request: string): Bucket.BucketParameters {
        for (let i = 0; i < this.bucketParamMap.length; i++) {
            const [match, params] = this.bucketParamMap[i];

            if (match == request)
                return params;
        }

        console.warn(`Unexpected request type: ${request}`);
        return this.defaultBucketParams;
    }

    public async clean(force: boolean = false): Promise<void> {
        const now = Date.now();

        // Wait at least 5 seconds between cleans
        if (!force && now - this.lastClean < 5000)
            return;

        this.lastClean = now;
        this.ctx.storage.put("lastClean", this.lastClean);

        // Get all buckets
        const request = await this.env.RELAY_D1.prepare(`
            SELECT * FROM buckets;    
        `).all();

        if (!request.success) {
            console.log(`D1 Error in clean: ${request.error}`);
            return;
        }

        // For each bucket
        for (const entry of request.results) {
            const bucketid = entry.bucketid as string;
            const bucketstate = JSON.parse(entry.bucketstate as string) as Bucket.BucketState;

            const bucket: Bucket.BucketData = {
                params: this.getParamsForRequest(bucketid.split(":")[1]),
                state: bucketstate
            }

            const deltaTime = now - bucket.state.lastUpdate;

            // If it has been over 5 minutes since a full bucket has been used, delete it
            if (
                deltaTime > 1000 * 60 * 5 &&
                Bucket.getTokenCount(bucket) >= bucket.params.capacity
            ) {
                this.env.RELAY_D1.prepare(`
                    DELETE FROM buckets WHERE bucketid = ?;
                `).bind(bucketid).run();
            }
        }
    }
}
