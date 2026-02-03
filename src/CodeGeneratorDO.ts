import { DurableObject } from "cloudflare:workers";

export class CodeGeneratorDO extends DurableObject<Env> {
    private seed?: number;
    private readonly codeLength: number;
    private readonly maximumCodeSeed: number;
    private readonly codeIncrementer: number;

    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.codeLength = env.CODE_LENGTH ?? 4;
        this.codeIncrementer = env.CODE_INCREMENTER ?? 174440041;
        this.maximumCodeSeed = Math.pow(26, this.codeLength);
    }

    async generateCode(): Promise<string> {
        if (this.seed === undefined) {
            var tempSeed = (await this.ctx.storage.get("rngSeed") as number | undefined) ?? (Math.floor(Math.random() * 174440041) % this.maximumCodeSeed);
            if (this.seed === undefined) {
                this.seed = tempSeed;
            }
        }

        this.seed += this.codeIncrementer;
        this.seed %= this.maximumCodeSeed;

        this.ctx.storage.put("rngSeed", this.seed);

        return this.convertNumberToCode(this.seed);
    }

    private convertNumberToCode(val: number): string {
        var result: string = "";

        for (var i = 0; i < this.codeLength; i++) {
            result += String.fromCharCode((val % 26) + 65);
            val /= 26;
            val = Math.floor(val);
        }

        return result;
    }
}