import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from 'ton-core';

export type JettonWalletConfig = {};

export function jettonWalletConfigToCell(config: JettonWalletConfig): Cell {
    return beginCell().endCell();
}

export class JettonWallet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JettonWallet(address);
    }

    static createFromConfig(config: JettonWalletConfig, code: Cell, workchain = 0) {
        const data = jettonWalletConfigToCell(config);
        const init = { code, data };
        return new JettonWallet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getJettonBalance(provider: ContractProvider) {
        let state = await provider.getState();
        if (state.state.type !== 'active') {
            return 0n;
        }
        let res = await provider.get('get_wallet_data', []);
        return res.stack.readBigNumber();
    }
    static transferMessage(jetton_amount: bigint, to: Address,
                           responseAddress:Address,
                           customPayload: Cell | null,
                           forward_ton_amount: bigint,
                           forwardPayload: Cell | null) {
        return beginCell().storeUint(0xf8a7ea5, 32).storeUint(0, 64) // op, queryId
                          .storeCoins(jetton_amount).storeAddress(to)
                          .storeAddress(responseAddress)
                          .storeMaybeRef(customPayload)
                          .storeCoins(forward_ton_amount)
                          .storeMaybeRef(forwardPayload)
               .endCell();
    }
    async sendTransfer(provider: ContractProvider, via: Sender,
                              value: bigint,
                              jetton_amount: bigint, to: Address,
                              responseAddress:Address,
                              customPayload: Cell | null,
                              forward_ton_amount: bigint,
                              forwardPayload: Cell | null) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.transferMessage(jetton_amount, to, responseAddress, customPayload, forward_ton_amount, forwardPayload),
            value:value
        });

    }
    /*
      burn#595f07bc query_id:uint64 amount:(VarUInteger 16)
                    response_destination:MsgAddress custom_payload:(Maybe ^Cell)
                    = InternalMsgBody;
    */
    static burnMessage(jetton_amount: bigint,
                       responseAddress:Address,
                       customPayload: Cell) {
        return beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64) // op, queryId
                          .storeCoins(jetton_amount).storeAddress(responseAddress)
                          .storeMaybeRef(customPayload)
               .endCell();
    }

    async sendBurn(provider: ContractProvider, via: Sender, value: bigint,
                          jetton_amount: bigint,
                          responseAddress:Address,
                          customPayload: Cell) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.burnMessage(jetton_amount, responseAddress, customPayload),
            value:value
        });

    }
    /*
      withdraw_tons#107c49ef query_id:uint64 = InternalMsgBody;
    */
    static withdrawTonsMessage() {
        return beginCell().storeUint(0x6d8e5e3c, 32).storeUint(0, 64) // op, queryId
               .endCell();
    }

    async sendWithdrawTons(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.withdrawTonsMessage(),
            value:toNano('0.1')
        });

    }
    /*
      withdraw_jettons#10 query_id:uint64 wallet:MsgAddressInt amount:Coins = InternalMsgBody;
    */
    static withdrawJettonsMessage(from:Address, amount:bigint) {
        return beginCell().storeUint(0x768a50b2, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(from)
                          .storeCoins(amount)
                          .storeMaybeRef(null)
               .endCell();
    }

    async sendWithdrawJettons(provider: ContractProvider, via: Sender, from:Address, amount:bigint) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.withdrawJettonsMessage(from, amount),
            value:toNano('0.1')
        });

    }

    /*
      vote query_id:uint64 voting_address:MsgAddressInt expiration_date:uint48 vote:Bool need_confirmation:Bool = InternalMsgBody;
    */
    static voteMessage(voting_address:Address, expiration_date:bigint, vote:boolean, need_confirmation:boolean = false) {
        return beginCell().storeUint(0x69fb306c, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(voting_address)
                          .storeUint(expiration_date, 48)
                          .storeBit(vote)
                          .storeBit(need_confirmation)
               .endCell();
    }

    async sendVote(provider: ContractProvider, via: Sender, voting_address:Address, expiration_date:bigint, vote:boolean, need_confirmation:boolean = false) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.voteMessage(voting_address, expiration_date, vote, need_confirmation),
            value:toNano('0.1')
        });
    }
    async getVotedWeight(provider: ContractProvider, voting_id:bigint, expiration_date:bigint) {
        let state = await provider.getState();
        if (state.state.type !== 'active') {
            return 0n;
        }
        let res = await provider.get('get_voted_weight', [{ type: 'int', value: voting_id}, { type: 'int', value: expiration_date}]);
        return res.stack.readBigNumber();
    }
    async getVoteKeeperAddress(provider: ContractProvider, voting_address:Address): Promise<Address> {
        const res = await provider.get('get_vote_keeper_address', [{ type: 'slice', cell: beginCell().storeAddress(voting_address).endCell() }])
        return res.stack.readAddress()
    }
}
