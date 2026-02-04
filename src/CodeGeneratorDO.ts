import { DurableObject } from "cloudflare:workers";

// Durable Object for generating unique lobby codes
export class CodeGeneratorDO extends DurableObject<Env> {
    // Current RNG seed
    private seed?: number;

    // Configuration parameters
    private readonly codeLength: number;
    private readonly maximumCodeSeed: number;
    private readonly codeIncrementer: number;

    // constructor
    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);

        // Initialize configuration parameters
        this.codeLength = env.CODE_LENGTH ?? 4;
        this.codeIncrementer = env.CODE_INCREMENTER ?? 174440041;
        this.maximumCodeSeed = Math.pow(26, this.codeLength);
    }

    // Generate a new unique lobby code
    async generateCode(): Promise<string> {
        // Initialize the seed if not already done
        if (this.seed === undefined) {
            // Get the stored seed or initialize it randomly
            var tempSeed = (await this.ctx.storage.get("rngSeed") as number | undefined) ?? (Math.floor(Math.random() * 174440041) % this.maximumCodeSeed);

            // Do not overwrite an existing seed if multiple requests come in simultaneously
            if (this.seed === undefined) {
                this.seed = tempSeed;
            }
        }

        // Increment the seed and store it
        this.seed += this.codeIncrementer;
        this.seed %= this.maximumCodeSeed;
        this.ctx.storage.put("rngSeed", this.seed);

        // Convert the seed to a lobby code and return it
        return this.convertNumberToCode(this.seed);
    }

    // Convert a number to a lobby code string
    private convertNumberToCode(val: number): string {
        var result: string = "";

        // Convert the number to a base-26 string using A-Z
        for (var i = 0; i < this.codeLength; i++) {
            result += String.fromCharCode((val % 26) + 65);
            val /= 26;
            val = Math.floor(val);
        }

        return result;
    }
}