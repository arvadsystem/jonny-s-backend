-- PostgreSQL grants EXECUTE on new functions to PUBLIC at the global default level.
-- A schema-local default ACL cannot subtract that global implicit grant, so this
-- global revoke is required. The public-schema ACL continues granting service_role.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
