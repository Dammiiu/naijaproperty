-- ---------------------------------------------------------------------------
-- Naijaproperty: invariants that must hold regardless of application code.
-- These are the guarantees the product's trust proposition depends on.
-- ---------------------------------------------------------------------------

-- 1. Kind coherence.
--    A listing's type must belong to the same kind as the listing. This is the
--    exact failure PropertyPro has today, where Sale and Rent render one shared
--    Type facet list (Self Contain under Sale, Lands under Rent). Enforcing it
--    in the database means the bug is unrepresentable, not merely avoided.
DROP TRIGGER IF EXISTS trg_listing_kind_coherence ON listings;

CREATE OR REPLACE FUNCTION njp_enforce_listing_kind_coherence()
RETURNS TRIGGER AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- MUST match on both columns. The primary key of listing_types is
  -- (kind_code, code), and several codes are intentionally present under both
  -- kinds (BUNGALOW, COMMERCIAL, SHOP, WAREHOUSE, OFFICE_SPACE). Selecting on
  -- `code` alone returns one arbitrary row of the pair, which makes the
  -- comparison below reject a perfectly valid rent bungalow.
  --
  -- So this checks existence of the exact (type_code, kind_code) pair, which is
  -- what the composite foreign key enforces as a hard guarantee. The trigger
  -- exists only to turn that violation into a readable error.
  SELECT TRUE INTO v_exists
    FROM listing_types
   WHERE code = NEW.type_code AND kind_code = NEW.kind_code;

  IF NOT FOUND THEN
    -- Distinguish "no such type" from "wrong kind", because the two mean very
    -- different things to whoever has to fix the data.
    IF EXISTS (SELECT 1 FROM listing_types WHERE code = NEW.type_code) THEN
      RAISE EXCEPTION
        'Listing type % exists but not for kind %. Rent and sale taxonomies are disjoint.',
        NEW.type_code, NEW.kind_code
        USING ERRCODE = '23514';
    END IF;

    RAISE EXCEPTION 'Unknown listing type: %', NEW.type_code
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_listing_kind_coherence
  BEFORE INSERT OR UPDATE OF type_code, kind_code ON listings
  FOR EACH ROW EXECUTE FUNCTION njp_enforce_listing_kind_coherence();

-- The trigger above is the readable failure. This constraint is the hard
-- guarantee: even a direct SQL write that bypasses application code cannot
-- attach a RENT type to a SALE listing.

-- 2. Price period coherence: rent requires a period, sale must not have one.
CREATE OR REPLACE FUNCTION njp_enforce_price_period()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind_code = 'RENT' AND NEW.price_period = 'NONE' THEN
    RAISE EXCEPTION 'Rent listings require a payment period'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.kind_code = 'SALE' AND NEW.price_period <> 'NONE' THEN
    RAISE EXCEPTION 'Sale listings must not declare a payment period'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_price_period ON listings;

CREATE TRIGGER trg_listing_price_period
  BEFORE INSERT OR UPDATE OF kind_code, price_period ON listings
  FOR EACH ROW EXECUTE FUNCTION njp_enforce_price_period();

-- 3. Land listings must declare a title type. The title-verification promise is
--    the core differentiator, so it cannot be optional on the highest-risk
--    listing type.
CREATE OR REPLACE FUNCTION njp_enforce_land_deed()
RETURNS TRIGGER AS $$
BEGIN
  -- Covers LAND (sale) and LAND_LEASE (rent). A leased plot is exactly the
  -- listing type most often used for "agent has no title, pay and sort it out
  -- later", so it must not be allowed to go live with deed_type = NONE.
  IF NEW.type_code IN ('LAND', 'LAND_LEASE') AND NEW.deed_type = 'NONE' THEN
    RAISE EXCEPTION
      'Land and land-lease listings must declare a title type'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_land_deed ON listings;

CREATE TRIGGER trg_listing_land_deed
  BEFORE INSERT OR UPDATE OF type_code, deed_type ON listings
  FOR EACH ROW EXECUTE FUNCTION njp_enforce_land_deed();

-- 4. Review credibility.
--    A review may only exist if its author actually contacted the owner
--    (contact_reveal) or completed a tenancy (stay_record), or an admin
--    explicitly overrode it. This is what makes reviews mean something on a
--    platform where anyone can otherwise post anything.
CREATE OR REPLACE FUNCTION njp_enforce_review_eligibility()
RETURNS TRIGGER AS $$
DECLARE
  v_reveal  BOOLEAN;
  v_stay    BOOLEAN;
BEGIN
  IF NEW.eligibility = 'ADMIN_OVERRIDE' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contact_reveals cr
    WHERE cr.listing_id = NEW.listing_id
      AND cr.viewer_id   = NEW.author_id
      AND cr.revoked_at IS NULL
  ) INTO v_reveal;

  SELECT EXISTS (
    SELECT 1 FROM stay_records sr
    WHERE sr.listing_id = NEW.listing_id
      AND sr.tenant_id   = NEW.author_id
  ) INTO v_stay;

  IF NOT (v_reveal OR v_stay) THEN
    RAISE EXCEPTION
      'Review author has no verified interaction with this listing'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_eligibility ON reviews;

CREATE TRIGGER trg_review_eligibility
  BEFORE INSERT OR UPDATE OF author_id, listing_id, eligibility ON reviews
  FOR EACH ROW EXECUTE FUNCTION njp_enforce_review_eligibility();

-- 5. Audit log append-only. No UPDATE or DELETE, even by mistake.
CREATE OR REPLACE FUNCTION njp_reject_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs;

CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION njp_reject_audit_mutation();

-- Indexes that back the public browse surface and the review queue are declared
-- in a Prisma migration instead of here. See
-- migrations/<timestamp>_invariant_indexes/migration.sql for the reasoning:
-- objects created outside the migration history make `prisma migrate dev` report
-- permanent drift and demand a database reset.