-- A cancelled job stays cancelled, whoever writes to it.
--
-- The cancel route flips the row and trusts the worker to notice at the next
-- stage boundary. But workers write progress INSIDE stages, and a worker whose
-- setStatus does not check for 'cancelled' -- any build before that guard, such
-- as a dev worker tunnelled in over SSH -- wrote the row straight back to
-- `downloading` moments after every cancel and delete. The job then counted as
-- running forever and refused every new one.
--
-- A guard in the worker only protects against workers that have it. This one
-- lives where every writer has to pass.
--
-- The one legitimate way out of 'cancelled' is regenerate, which resets the
-- row to 'pending' before re-queueing it; the worker then moves it on from
-- there, which this does not touch. Anything else is skipped: RETURN NULL drops
-- that row from the UPDATE without an error, so an old worker's setStatus
-- simply matches nothing, and its next assertNotCancelled stops the job.
CREATE OR REPLACE FUNCTION jobs_keep_cancelled() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status NOT IN ('cancelled', 'pending') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_keep_cancelled ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_keep_cancelled
  BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_keep_cancelled();
