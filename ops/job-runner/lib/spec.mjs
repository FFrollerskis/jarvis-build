/**
 * WP-C1: ENESTE import av den delte container-spesifikasjonen (flaggene bor i `modules/tasks/src/job-container-spec.mjs`, delt
 * med worker-siden). Ligger i ett punkt slik at installasjonslayouten (`ops/job-runner/` + `modules/tasks/src/job-container-spec.mjs`
 * under samme rot) bare avhenger av én relativ sti.
 */
export {
  ENV_NAME, FORBIDDEN_ENV, HOST_RUNNER_FORBIDDEN_ENV, JobContainerConfigError, NETWORK_NAME,
  buildJobContainerCreateArgs, isHostRunnerEnvNameAllowed, validateJobContainerPolicy
} from "../../../modules/tasks/src/job-container-spec.mjs";
