import React, { useCallback, useContext, useEffect, useState } from "react";
import { useConnection } from "./connection";
import { useWallet } from "./wallet";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { programIds, SWAP_HOST_FEE_ADDRESS, WRAPPED_SOL_MINT } from "./ids";
import { AccountLayout, u64, MintInfo, MintLayout } from "@solana/spl-token";
import { usePools } from "./pools";
import { TokenAccount, PoolInfo } from "./../models";
import { notify } from "./notifications";

const AccountsContext = React.createContext<any>(null);

// Define custom events for account updates
class AccountUpdateEvent extends Event {
  static type = "AccountUpdate";
  id: string;
  constructor(id: string) {
    super(AccountUpdateEvent.type);
    this.id = id;
  }
}

class EventEmitter extends EventTarget {
  raiseAccountUpdated(id: string) {
    this.dispatchEvent(new AccountUpdateEvent(id));
  }
}

// Initialize account emitter
const accountEmitter = new EventEmitter();

// Create cache for mint and account data
const mintCache = new Map<string, Promise<MintInfo>>();
const pendingAccountCalls = new Map<string, Promise<TokenAccount>>();
const accountsCache = new Map<string, TokenAccount>();

// Fetch account information from Solana blockchain
const getAccountInfo = async (connection: Connection, pubKey: PublicKey) => {
  const info = await connection.getAccountInfo(pubKey);
  if (info === null) {
    throw new Error("Failed to find account");
  }

  const buffer = Buffer.from(info.data);
  const data = deserializeAccount(buffer);

  const details = {
    pubkey: pubKey,
    account: { ...info },
    info: data,
  } as TokenAccount;

  return details;
};

// Fetch mint information from Solana blockchain
const getMintInfo = async (connection: Connection, pubKey: PublicKey) => {
  const info = await connection.getAccountInfo(pubKey);
  if (info === null) {
    throw new Error("Failed to find mint account");
  }

  const data = Buffer.from(info.data);
  return deserializeMint(data);
};

// Cache for account and mint data
export const cache = {
  getAccount: async (connection: Connection, pubKey: string | PublicKey) => {
    // Convert public key to PublicKey object
    const id = typeof pubKey === "string" ? new PublicKey(pubKey) : pubKey;
    const address = id.toBase58();

    // Check if account data is already cached
    let account = accountsCache.get(address);
    if (account) {
      return account;
    }

    // Check if account data is being fetched
    let query = pendingAccountCalls.get(address);
    if (query) {
      return query;
    }

    // Fetch account data from Solana blockchain
    query = getAccountInfo(connection, id).then((data) => {
      pendingAccountCalls.delete(address);
      accountsCache.set(address, data);
      return data;
    }) as Promise<TokenAccount>;
    pendingAccountCalls.set(address, query as any);

    return query;
  },
  getMint: async (connection: Connection, pubKey: string | PublicKey) => {
    // Convert public key to PublicKey object
    const id = typeof pubKey === "string" ? new PublicKey(pubKey) : pubKey;

    // Check if mint data is already cached
    let mint = mintCache.get(id.toBase58());
    if (mint) {
      return mint;
    }

    // Fetch mint data from Solana blockchain
    let query = getMintInfo(connection, id);
    mintCache.set(id.toBase58(), query as any);

    return query;
  },
};

// Wrap native SOL account
function wrapNativeAccount(pubkey: PublicKey, account?: AccountInfo<Buffer>): TokenAccount | undefined {
  if (!account) {
    return undefined;
  }

  return {
    pubkey: pubkey,
    account,
    info: {
      mint: WRAPPED_SOL_MINT,
      owner: pubkey,
      amount: new u64(account.lamports),
      delegate: null,
      delegatedAmount: new u64(0),
      isInitialized: true,
      isFrozen: false,
      isNative: true,
      rentExemptReserve: null,
      closeAuthority: null,
    },
  };
}

// Hook to retrieve native SOL account
const useNativeAccount = () => {
  const connection = useConnection();
  const { wallet } = useWallet();
  const [nativeAccount, setNativeAccount] = useState<AccountInfo<Buffer>>();

  useEffect(() => {
    if (!connection || !wallet?.publicKey) {
      return;
    }

    connection.getAccountInfo(wallet.publicKey).then((acc) => {
      if (acc) {
        setNativeAccount(acc);
      }
    });
    connection.onAccountChange(wallet.publicKey, (acc) => {
      if (acc) {
        setNativeAccount(acc);
      }
    });
  }, [setNativeAccount, wallet, wallet.publicKey, connection]);

  return { nativeAccount };
};

// Function to precache user token accounts
const precacheUserTokenAccounts = async (connection: Connection, owner?: PublicKey) => {
  if (!owner) {
    return;
  }

  // Fetch user token accounts from Solana blockchain
  const accounts = await connection.getTokenAccountsByOwner(owner, {
    programId: programIds().token,
  });

  // Store token accounts in cache
  accounts.value.forEach((info) => {
    const data = deserializeAccount(info.account.data);
    const details = {
      pubkey: info.pubkey,
      account: { ...info.account },
      info: data,
    } as TokenAccount;

    accountsCache.set(details.pubkey.toBase58(), details);
  });
};

// Inside AccountsProvider component
const useNativeAccountInternal = () => {
  const connection = useConnection();
  const { wallet } = useWallet();
  const [nativeAccount, setNativeAccount] = useState<AccountInfo<Buffer>>();

  useEffect(() => {
    if (!connection || !wallet?.publicKey) {
      return;
    }

    connection.getAccountInfo(wallet.publicKey).then((acc) => {
      if (acc) {
        setNativeAccount(acc);
      }
    });
    connection.onAccountChange(wallet.publicKey, (acc) => {
      if (acc) {
        setNativeAccount(acc);
      }
    });
  }, [setNativeAccount, wallet, wallet.publicKey, connection]);

  return { nativeAccount };
};

// Usage within AccountsProvider component
const { nativeAccount } = useNativeAccountInternal();

  // Select user accounts
  const selectUserAccounts = useCallback(() => {
    return [...accountsCache.values()].filter(
      (a) => a.info.owner.toBase58() === wallet.publicKey.toBase58()
    );
  }, [wallet]);

  // Update user accounts
  useEffect(() => {
    setUserAccounts(
      [
        wrapNativeAccount(wallet.publicKey, nativeAccount),
        ...tokenAccounts,
      ].filter((a) => a !== undefined) as TokenAccount[]
    );
  }, [nativeAccount, wallet, tokenAccounts]);

  // Effect for fetching and updating token accounts
  useEffect(() => {
    if (!connection || !wallet || !wallet.publicKey) {
      setTokenAccounts([]);
    } else {
      // Cache host accounts to avoid query during swap
      precacheUserTokenAccounts(connection, SWAP_HOST_FEE_ADDRESS);

      precacheUserTokenAccounts(connection, wallet.publicKey).then(() => {
        setTokenAccounts(selectUserAccounts());
      });
// Subscribe to account changes for token accounts
      const tokenSubID = connection.onProgramAccountChange(
        programIds().token,
        (info) => {
          const id = info.accountId.toBase58();
          if (
            info.accountInfo.data.length === AccountLayout.span &&
            (PRECACHED_OWNERS.has(info.accountInfo.owner.toBase58()) ||
              accountsCache.has(id))
          ) {
            const data = deserializeAccount(info.accountInfo.data);
            const details = {
              pubkey: info.accountId,
              account: { ...info.accountInfo },
              info: data,
            } as TokenAccount;

            accountsCache.set(id, details);
            setTokenAccounts(selectUserAccounts());
            accountEmitter.raiseAccountUpdated(id);
          }
        },
        "singleGossip"
      );

      // Clean up subscription on unmount
      return () => {
        connection.removeProgramAccountChangeListener(tokenSubID);
      };
    }
  }, [connection, connected, wallet?.publicKey]);

  // Return the context provider with children
  return (
    <AccountsContext.Provider
      value={{
        userAccounts,
        pools,
        nativeAccount,
      }}
    >
      {children}
    </AccountsContext.Provider>
  );
}

// Custom hook to access native SOL account
export function useNativeAccount() {
  const context = useContext(AccountsContext);
  return {
    account: context.nativeAccount as AccountInfo<Buffer>,
  };
}

// Custom hook to access mint information
export function useMint(id?: string) {
  const connection = useConnection();
  const [mint, setMint] = useState<MintInfo>();

  useEffect(() => {
    if (!id) {
      return;
    }

    cache
      .getMint(connection, id)
      .then(setMint)
      .catch((err) =>
        notify({
          message: err.message,
          type: "error",
        })
      );
    const onAccountEvent = (e: Event) => {
      const event = e as AccountUpdateEvent;
      if (event.id === id) {
        cache.getMint(connection, id).then(setMint);
      }
    };

    accountEmitter.addEventListener(AccountUpdateEvent.type, onAccountEvent);
    return () => {
      accountEmitter.removeEventListener(
        AccountUpdateEvent.type,
        onAccountEvent
      );
    };
  }, [connection, id]);

  return mint;
}

// Custom hook to access user accounts
export function useUserAccounts() {
  const context = useContext(AccountsContext);
  return {
    userAccounts: context.userAccounts as TokenAccount[],
  };
}

// Custom hook to access a specific account by public key
export function useAccount(pubKey?: PublicKey) {
  const connection = useConnection();
  const [account, setAccount] = useState<TokenAccount>();

  const key = pubKey?.toBase58();
  useEffect(() => {
    const query = async () => {
      try {
        if (!key) {
          return;
        }

        const acc = await cache.getAccount(connection, key).catch((err) =>
          notify({
            message: err.message,
            type: "error",
          })
        );
        if (acc) {
          setAccount(acc);
        }
      } catch (err) {
        console.error(err);
      }
    };

    query();

    const onAccountEvent = (e: Event) => {
      const event = e as AccountUpdateEvent;
      if (event.id === key) {
        query();
      }
    };

    accountEmitter.addEventListener(AccountUpdateEvent.type, onAccountEvent);
    return () => {
      accountEmitter.removeEventListener(
        AccountUpdateEvent.type,
        onAccountEvent
      );
    };
  }, [connection, key]);

  return account;
}

// Custom hook to access cached pool information
export function useCachedPool() {
  const context = useContext(AccountsContext);
  return {
    pools: context.pools as PoolInfo[],
  };
}

// Custom hook to access a selected account by its public key
export const useSelectedAccount = (account: string) => {
  const { userAccounts } = useUserAccounts();
  const index = userAccounts.findIndex(
    (acc) => acc.pubkey.toBase58() === account
  );

  return index !== -1 ? userAccounts[index] : undefined;
};

// Custom hook to access an account by its mint ID
export const useAccountByMint = (mint: string) => {
  const { userAccounts } = useUserAccounts();
  const index = userAccounts.findIndex(
    (acc) => acc.info.mint.toBase58() === mint
  );

  return index !== -1 ? userAccounts[index] : undefined;
};
