import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
  type DynamicModule,
} from "@nestjs/common";

/** Something the deployable needs before it can usefully serve a request. */
export interface ReadinessCheck {
  readonly name: string;
  readonly check: () => Promise<void>;
}

export interface HealthOptions {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly checks?: readonly ReadinessCheck[];
}

export const HEALTH_OPTIONS = Symbol("HEALTH_OPTIONS");

/** The same shape from all three deployables, the Dashboard's route included. */
export interface LivenessBody {
  readonly status: "ok";
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly uptimeSeconds: number;
}

export interface ReadinessBody {
  readonly status: "ready" | "not-ready";
  readonly service: string;
  readonly checks: Record<string, "ok" | string>;
}

@Controller("health")
export class HealthController {
  public constructor(@Inject(HEALTH_OPTIONS) private readonly options: HealthOptions) {}

  /** Liveness. The process is up and answering; it says nothing about Postgres. */
  @Get()
  public live(): LivenessBody {
    return {
      status: "ok",
      service: this.options.service,
      version: this.options.version,
      environment: this.options.environment,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Readiness. Every dependency this deployable cannot serve without. */
  @Get("ready")
  public async ready(): Promise<ReadinessBody> {
    const checks: Record<string, "ok" | string> = {};

    for (const check of this.options.checks ?? []) {
      try {
        await check.check();
        checks[check.name] = "ok";
      } catch (error) {
        checks[check.name] = error instanceof Error ? error.message : String(error);
      }
    }

    const failed = Object.values(checks).some((outcome) => outcome !== "ok");
    const body: ReadinessBody = {
      status: failed ? "not-ready" : "ready",
      service: this.options.service,
      checks,
    };
    if (failed) throw new ServiceUnavailableException(body);
    return body;
  }
}

@Module({})
export class HealthModule {
  public static forService(options: HealthOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_OPTIONS, useValue: options }],
    };
  }
}
