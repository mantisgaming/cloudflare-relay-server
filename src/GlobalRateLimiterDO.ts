import { DurableObject } from "cloudflare:workers";
import { Bucket } from "./Bucket";

type BucketMap = Map<string, Bucket.BucketData>;
type BucketParamMap = [string, Bucket.BucketParameters][];

// Durable Object for generating unique lobby codes
export class GlobalRateLimiterDO extends DurableObject<Env> {
    private readonly bucketMap: BucketMap;
    private readonly bucketParamMap: BucketParamMap;
    private readonly defaultBucketParams: Bucket.BucketParameters = {
        capacity: 200,
        fillRate: 600
    };

    private lastClean: number = Date.now();

    // constructor
    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.bucketMap = new Map();
        this.bucketParamMap = [
            ["any", {
                capacity: 200,
                fillRate: 1200
            }],
            ["create", {
                capacity: 200,
                fillRate: 300
            }],
            ["reconnect", {
                capacity: 200,
                fillRate: 300
            }],
            ["join", {
                capacity: 300,
                fillRate: 600
            }],
        ];
    }

    /** Acquire permission to make a request */
    public acquireToken(requestType: string): boolean {
        const bucketKeys: string[] = [
            "any",
            requestType,
        ];

        const buckets = bucketKeys.map<Bucket.BucketData>(this.getBucket.bind(this));

        const now = Date.now();

        for (let i = 0; i < buckets.length; i++) {
            const bucket = buckets[i];

            if (!Bucket.hasToken(bucket, now))
                return false;
        }

        for (let i = 0; i < buckets.length; i++) {
            Bucket.decrement(buckets[i], now);
        }

        return true;
    }

    private getBucket(key: string): Bucket.BucketData {
        // return an existing bucket
        if (this.bucketMap.has(key))
            return this.bucketMap.get(key)!;

        // initialize a new bucket
        const params = this.getParamsForRequest(key);
        const newBucket: Bucket.BucketData = {
            params,
            state: Bucket.createDefaultState(params)
        }

        // insert and return the new bucket
        this.bucketMap.set(key, newBucket)
        return newBucket;
    }

    private getParamsForRequest(request: string): Bucket.BucketParameters {
        for (let i = 0; i < this.bucketParamMap.length; i++) {
            const [match, params] = this.bucketParamMap[i];

            if (match == request)
                return params;
        }

        return this.defaultBucketParams;
    }

    public clean(): void {
        const now = Date.now();

        // Wait at least 5 seconds between cleans
        if (now - this.lastClean < 5000)
            return;

        this.lastClean = now;

        // For each bucket
        for (const [key, val] of this.bucketMap) {
            const deltaTime = now - val.state.lastUpdate;

            // If the bucket is not full
            if (val.state.tokens != val.params.capacity) {
                // Update it if it has been over a minute since the bucket was used
                if (deltaTime > 1000 * 60) {
                    Bucket.normalize(val, now);
                }

                continue;
            }

            // If it has been over 5 minutes that the bucket has been filled, delete it
            if (deltaTime > 1000 * 60 * 5 && val.state.tokens == val.params.capacity) {
                this.bucketMap.delete(key);

                continue;
            }
        }
    }
}
