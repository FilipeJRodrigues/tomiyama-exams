import { useContext } from 'react';

import { AuthContext, type AuthContextValue } from './context';

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth precisa estar dentro de AuthProvider');
  return value;
}
