local json = require("json")

-- Initial state
state = state or {
    processes = {},
    withdrawals = {},
    senditStreaks = {}
}

-- Utility to extract tag values
local function getTagValue(msg, tagName)
    return msg.Tags and msg.Tags[tagName] or nil
end

-- Unified registration handler
Handlers.add("Register-Process", { Action = "Register-Process" }, function(msg)
    print("DEBUG: Register-Process received tags: " .. json.encode(msg.Tags or {}))
    
    local processId = getTagValue(msg, "Process-ID")
    local userId = getTagValue(msg, "User-ID")
    local depositAddress = getTagValue(msg, "Deposit-Address")
    local parent = getTagValue(msg, "Parent")
    local derivationIndex = getTagValue(msg, "Derivation-Index") or "0" -- Optional tag from parent

    if not (processId and userId and depositAddress and parent) then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Missing required tags" }) })
        return
    end

    if state.processes[processId] then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Process already registered" }) })
        return
    end

    state.processes[processId] = {
        userId = userId,
        depositAddress = depositAddress,
        parent = parent,
        derivationIndex = tonumber(derivationIndex), -- Store as number
        balance = 0
    }
    ao.send({ Target = msg.From, Data = json.encode({ Success = true, processId = processId }) })
end)

-- Get user process info
Handlers.add("Get-User-Process", { Action = "Get-User-Process" }, function(msg)
    local userId = getTagValue(msg, "User-ID")
    if not userId then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "User-ID required" }) })
        return
    end

    for processId, info in pairs(state.processes) do
        if info.userId == userId then
            ao.send({
                Target = msg.From,
                Data = json.encode({
                    Success = true,
                    processId = processId,
                    depositAddress = info.depositAddress,
                    derivationIndex = info.derivationIndex, -- Include index
                    balance = info.balance
                })
            })
            return
        end
    end 
    ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Process not found" }) })
end)


-- Get internal balance
Handlers.add("Get-Balance", { Action = "Get-Balance" }, function(msg)
    local processId = getTagValue(msg, "Process-ID")
    if not processId or not state.processes[processId] then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Invalid process ID" }) })
        return
    end
    ao.send({
        Target = msg.From,
        Data = json.encode({ Success = true, balance = state.processes[processId].balance })
    })
end)


-- Credit balance handler 
Handlers.add("CreditBalance", { Action = "CreditBalance" }, function(msg)
    -- Extract processId and amount from the message data
    local data = msg.Data and json.decode(msg.Data) or {}
    local processId = data.processId
    local amount = tonumber(data.amount)

    -- Validate inputs
    if not processId then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Missing processId" }) })
        return
    end
    if not amount or amount <= 0 then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Invalid or missing amount" }) })
        return
    end

    -- Check if the process exists
    if not state.processes[processId] then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Process not found" }) })
        return
    end

    -- Update the balance
    state.processes[processId].balance = (state.processes[processId].balance or 0) + amount
    ao.send({
        Target = msg.From,
        Data = json.encode({
            Success = true,
            message = "Balance credited",
            NewBalance = tostring(state.processes[processId].balance) -- Ensure string for AO compatibility
        })
    })
end)

-- Transfer balance between users
Handlers.add("TransferBalance", { Action = "TransferBalance" }, function(msg)
    local fromProcessId = getTagValue(msg, "From-Process-ID")
    local toProcessId = getTagValue(msg, "To-Process-ID")
    local amountStr = getTagValue(msg, "Amount")
    local amount = tonumber(amountStr)

    if not (fromProcessId and toProcessId and amount) then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Missing required tags" }) })
        return
    end

    if not (state.processes[fromProcessId] and state.processes[toProcessId]) then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Invalid process IDs" }) })
        return
    end

    if state.processes[fromProcessId].balance < amount then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Insufficient balance" }) })
        return
    end

    state.processes[fromProcessId].balance = state.processes[fromProcessId].balance - amount
    state.processes[toProcessId].balance = state.processes[toProcessId].balance + amount
    ao.send({
        Target = msg.From,
        Data = json.encode({
            Success = true,
            message = "Transfer completed",
            SenderNewBalance = tostring(state.processes[fromProcessId].balance),
            ReceiverNewBalance = tostring(state.processes[toProcessId].balance)
        })
    })
end)

-- Request a withdrawal
Handlers.add("RequestWithdrawal", { Action = "RequestWithdrawal" }, function(msg)
    local processId = getTagValue(msg, "Process-ID")
    local amountStr = getTagValue(msg, "Amount")
    local amount = tonumber(amountStr)

    if not (processId and amount) then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Missing required tags" }) })
        return
    end

    if not state.processes[processId] then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Process not found" }) })
        return
    end

    if state.processes[processId].balance < amount then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Insufficient balance" }) })
        return
    end

    state.processes[processId].balance = state.processes[processId].balance - amount
    state.withdrawals[processId] = state.withdrawals[processId] or {}
    state.withdrawals[processId][msg.Id] = { amount = amount, status = "pending" }
    ao.send({ Target = msg.From, Data = json.encode({ Success = true, withdrawalId = msg.Id }) })
end)

-- Debit notice after the withdraw 
Handlers.add("DebitBalance", { Action = "DebitBalance" }, function(msg)
    local data = msg.Data and json.decode(msg.Data) or {}
    local processId = data.processId
    local amount = tonumber(data.amount)
    
    if not processId then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Missing processId" }) })
        return
    end
    if not amount or amount <= 0 then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Invalid or missing amount" }) })
        return
    end
    if not state.processes[processId] then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Process not found" }) })
        return
    end
    if state.processes[processId].balance < amount then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "Insufficient balance" }) })
        return
    end

    state.processes[processId].balance = state.processes[processId].balance - amount
    ao.send({
        Target = msg.From,
        Data = json.encode({ 
            Success = true, 
            message = "Balance debited", 
            NewBalance = tostring(state.processes[processId].balance)
        })
    })
end)


-- Sendit streak handler

Handlers.add("sendit", { Action = "sendit" }, function(msg)
    local userId = getTagValue(msg, "User-ID")
    if not userId then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "User-ID required" }) })
        return
    end

    local currentTime = tonumber(getTagValue(msg, "Timestamp") or os.time())
    local streakData = state.senditStreaks[userId] or { count = 0, lastTimestamp = 0, history = {} }
    local timeDiff = currentTime - streakData.lastTimestamp

    if timeDiff <= 86400 then
        streakData.count = streakData.count + 1
    else
        streakData.count = 1
    end
    streakData.lastTimestamp = currentTime
    streakData.history = streakData.history or {}
    table.insert(streakData.history, currentTime)
    state.senditStreaks[userId] = streakData

    ao.send({
        Target = msg.From,
        Data = json.encode({ Success = true, message = "SEND't it! Keep the streak alive!", streak = streakData.count })
    })
end)

Handlers.add("Get-Sendit-Streak", { Action = "Get-Sendit-Streak" }, function(msg)
    local userId = getTagValue(msg, "User-ID")
    if not userId then
        ao.send({ Target = msg.From, Data = json.encode({ Success = false, message = "User-ID required" }) })
        return
    end
    local streakData = state.senditStreaks[userId] or { count = 0, lastTimestamp = 0, history = {} }
    ao.send({
        Target = msg.From,
        Data = json.encode({ Success = true, streak = streakData.count, lastTimestamp = streakData.lastTimestamp, history = streakData.history })
    })
end)