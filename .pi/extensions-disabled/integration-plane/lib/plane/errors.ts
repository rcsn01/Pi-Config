export class PlaneConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PlaneConfigError"
	}
}

export class PlaneApiError extends Error {
	status: number
	body: string

	constructor(message: string, status: number, body: string) {
		super(message)
		this.name = "PlaneApiError"
		this.status = status
		this.body = body
	}
}
