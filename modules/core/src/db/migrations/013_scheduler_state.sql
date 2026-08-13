-- BO-05: reboot-durabel scheduler med multi-instans-laas (en vinner per dag)
CREATE TABLE scheduler_state (
  job_name      text NOT NULL,
  run_date      date NOT NULL,
  claimed_by    text NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (job_name, run_date)
);
GRANT SELECT, INSERT, UPDATE ON scheduler_state TO jarvis_app;
