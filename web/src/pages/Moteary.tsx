import MotearyWorkspace from "@/components/MotearyWorkspace/MotearyWorkspace";
import useCurrentUser from "@/hooks/useCurrentUser";

/** Account-scoped UI state must not survive an account change. The route also requires authentication. */
const Moteary = () => {
  const user = useCurrentUser();
  return user ? <MotearyWorkspace key={user.name} userName={user.name} /> : null;
};

export default Moteary;
