import { Telegraf } from 'telegraf';
import  { db }  from "../src/lib/db";
import * as dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';

import { getMint, getAccount, TokenInvalidInstructionProgramError } from '@solana/spl-token';
//import { Metadata } from '@metaplex-foundation/mpl-token-metadata';

const API = 'https://defi.shyft.to/v0/pools/get_by_token?network=mainnet-beta&token=6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'; // example
const API_KEY = '90Bm2AsZnZslHvD-';
const connection = new Connection('https://solana-mainnet.g.alchemy.com/v2/7MhrOFJdbrpHzDB8yhYw9mD0zjzGPeux');

dotenv.config();

// ✅ Initialize the bot
const bot = new Telegraf(process.env.BOT_TOKEN || '');

// Helper to sum token balances for a wallet
async function sumTokenAccounts(walletAddress: string, mintPubKey: PublicKey) {

  
  let total = BigInt(0);
  const ownerPubKey = new PublicKey(walletAddress);
  const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPubKey, { mint: mintPubKey });
  
      //const pubkeys = new PublicKey('4718at6MKguFJPaL1J8hkxJ23tmW4vn8oRbrKngKZE4m');
      //const accountInfo = await getAccount(connection, pubkeys);
     //console.log(accountInfo)


  if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
    // token accounts found
       //console.log(tokenAccounts.value)
       
      for (const { pubkey } of tokenAccounts.value) {
        // Fetch token account details
        const tokenAccountInfo = await getAccount(connection, pubkey);
        
        total += tokenAccountInfo.amount;
      }

  } else {
       //console.log(ownerPubKey);
        const tokenAccountInfo = await getAccount(connection, ownerPubKey);
      total += tokenAccountInfo.amount;

    // no token accounts found for this owner + mint
  }


  return total;
}


type AnyObject = Record<string, any>;
type PoolsByDex = Record<string, string[]>;

bot.on('text', async (ctx) => {
   const input = ctx.message.text;
  const parts = input.trim().split(' ');

  if (parts.length < 3) {
    return ctx.reply('Usage: /stats <token_mint_address> <comma_separated_owner_wallets>');
  }

  const tokenMintAddress = parts[1];
  const ownerWallets = parts[2].split(',');

   function toArray(val: unknown): AnyObject[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as AnyObject[];
  if (typeof val === "object") {
    const obj = val as AnyObject;
    //if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.pools)) return obj.pools;
    //if (Array.isArray(obj.data)) return obj.data;

    // if it looks like a single pool
    if ("pool_address" in obj || "pubkey" in obj || "address" in obj || "id" in obj) {
      return [obj];
    }

    return Object.values(obj);
  }
  return [];
   }

  function getPoolAddress(pool: AnyObject): string | null {
    return  pool.pubkey;
  }

  try {
    const mintPubKey = new PublicKey(tokenMintAddress);
    const mintInfo = await getMint(connection, mintPubKey);
    const decimals = mintInfo.decimals;
    const totalSupply = mintInfo.supply;

        const url = `https://defi.shyft.to/v0/pools/get_by_token?network=mainnet-beta&token=${tokenMintAddress}`;
        const res = await fetch(url, {
          headers: { "x-api-key": API_KEY }
        });

        const data = await res.json();
        const dexes = data?.result?.dexes ?? {};
        const allPools: string[] = []; 
        
        const vaults: string[] = [];
       // console.log(dexes.raydiumAmm);

        for (const dexName of Object.keys(dexes)) {
          const arr = toArray(dexes[dexName]);
            //console.log(arr)
          arr.forEach(pool => {

            
        if (pool.baseMint === tokenMintAddress && pool.baseVault) vaults.push(pool.baseVault);
        if (pool.quoteMint === tokenMintAddress && pool.quoteVault) vaults.push(pool.quoteVault);

        if (pool.base_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_base_token_account);
        if (pool.quote_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_quote_token_account);

        if (pool.tokenMintA === tokenMintAddress && pool.tokenVaultA) vaults.push(pool.tokenVaultA);
        if (pool.tokenMintB === tokenMintAddress && pool.tokenVaultB) vaults.push(pool.tokenVaultB);
        if (pool.tokenXMint === tokenMintAddress && pool.reserveX) vaults.push(pool.reserveX);
        if (pool.tokenYMint === tokenMintAddress && pool.reserveY) vaults.push(pool.reserveY);
        
            const addr =  getPoolAddress(pool);
            
            if (addr) allPools.push(addr);
          });
        }

   // console.log(vaults)

    // Sum DEX balances concurrently
    /*const dexBalances = await Promise.all(
      vaults.map(wallet => sumTokenAccounts(wallet, mintPubKey))
    );
   const dexBalance = dexBalances.reduce((a, b) => a + b, BigInt(0));
  */

    // Sum DEX balances concurrently
    const dexBalances = await Promise.all(
    vaults.map(async (wallet) => {
      const bal = await sumTokenAccounts(wallet, mintPubKey);
      return bal; // bigint
    })
    );

    // Keep only vaults with > 0 balance
    const nonZeroVaults = vaults.filter((_, i) => dexBalances[i] > BigInt(0));

    // Now calculate total DEX balance only from non-zero vaults
    const dexBalance = dexBalances.reduce((a, b) => a + b, BigInt(0));


    // Sum owner balances
    let ownerBalance = BigInt(0);
    for (const wallet of ownerWallets) {
      ownerBalance += await sumTokenAccounts(wallet, mintPubKey);
    }


    const unknownBalance = totalSupply - dexBalance - ownerBalance;

    const convertToNumber = (amount: bigint) => Number(amount) / Math.pow(10, decimals);
    const totalSupplyNum = convertToNumber(totalSupply);

    const dexPercent = (convertToNumber(dexBalance) / totalSupplyNum) * 100;
    const ownerPercent = (convertToNumber(ownerBalance) / totalSupplyNum) * 100;
    const unknownPercent = (convertToNumber(unknownBalance) / totalSupplyNum) * 100;


    ctx.reply(`
      <b>Token Distribution</b>

      <pre>
      Category         Value
      -----------------------------
      Total Supply     ${totalSupplyNum.toFixed(6)}
      Dex              ${dexPercent.toFixed(2)}%
      Owner Wallets    ${ownerPercent.toFixed(2)}%
      Unknown Wallets  ${unknownPercent.toFixed(2)}%
      </pre>
      `, { parse_mode: "HTML" });


  } catch (e) {
    console.error(e);
    ctx.reply('Error fetching token data. Please check the token mint address and wallet addresses.');
  }
});

bot.launch();